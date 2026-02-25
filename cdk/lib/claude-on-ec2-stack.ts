import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';

export class ClaudeOnEc2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──────────────────────────────────────────────
    // デフォルト VPC を参照（シンプル構成）
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // ── IAM ロール ────────────────────────────────────────
    // SSM Session Manager でポート不要の接続を実現するために必須
    // AdministratorAccess: EC2 上から AWS CLI / SDK で AWS 操作を行うために追加
    // ⚠️ 最小権限の原則に基づき、本番運用時は必要なポリシーのみに絞ることを推奨
    const role = new iam.Role(this, 'ClaudeEc2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
      ],
    });

    // ── セキュリティグループ ──────────────────────────────
    // インバウンドは全閉じ（SSH ポート 22 も不要）
    // アウトバウンドは全許可（SSM・npm・Anthropic API 通信が必要）
    const sg = new ec2.SecurityGroup(this, 'ClaudeEc2Sg', {
      vpc,
      description: 'Claude Code EC2 - No inbound, outbound all allowed',
      allowAllOutbound: true,
    });

    // ── User Data（起動時に自動でセットアップ） ──────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // ① システムアップデートと基本ツール
      'dnf update -y',
      'dnf install -y tmux git',

      // ② nvm + Node.js + Claude Code を ec2-user としてインストール
      'sudo -u ec2-user -i bash -c "' +
        'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && ' +
        'source ~/.nvm/nvm.sh && ' +
        'nvm install --lts && ' +
        'npm install -g @anthropic-ai/claude-code' +
        '"',

      // ③ tmux + Claude Code 自動起動スクリプトを作成
      // 注意: 初回は SSM 接続して手動で claude にログインする必要がある
      //       一度認証後は EC2 再起動時にこのスクリプトが自動実行される
      [
        "cat > /usr/local/bin/claude-autostart.sh << 'ENDSCRIPT'",
        '#!/bin/bash',
        'export HOME=/home/ec2-user',
        'export TERM=xterm-256color',
        'export NVM_DIR="$HOME/.nvm"',
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
        '# 既存の tmux セッションがなければ新規作成して Claude Code を起動',
        'if ! tmux has-session -t claude 2>/dev/null; then',
        '  # 古いソケットの残骸をクリーンアップ',
        '  tmux kill-server 2>/dev/null || true',
        '  sleep 0.5',
        '  # セッション作成（ホームディレクトリで起動）',
        '  tmux new-session -d -s claude -x 220 -y 50',
        '  # claude が終了したら自動でペインを再起動する設定',
        '  tmux set-option -t claude remain-on-exit on',
        "  tmux set-hook -t claude pane-died 'respawn-pane -k -t claude:0.0'",
        '  sleep 1',
        "  tmux send-keys -t claude 'export TERM=xterm-256color && cd /home/ec2-user && source ~/.nvm/nvm.sh && claude' Enter",
        'fi',
        'ENDSCRIPT',
      ].join('\n'),
      'chmod +x /usr/local/bin/claude-autostart.sh',

      // ④ systemd サービス登録（再起動時に自動起動）
      [
        "cat > /etc/systemd/system/claude-code.service << 'EOF'",
        '[Unit]',
        'Description=Claude Code Remote Control',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=oneshot',
        'RemainAfterExit=yes',
        'User=ec2-user',
        'ExecStart=/usr/local/bin/claude-autostart.sh',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        'EOF',
      ].join('\n'),
      'systemctl daemon-reload',
      'systemctl enable claude-code.service',

      // ⑤ ~/.bashrc に tmux 自動アタッチと TERM 設定を追加
      [
        "cat >> /home/ec2-user/.bashrc << 'EOF'",
        '',
        '# Claude Code on EC2: TERM 設定（Bash ツール対策）',
        'export TERM=xterm-256color',
        '',
        '# tmux 自動アタッチ（sudo su - ec2-user した瞬間に claude セッションに入る）',
        'if [[ -z "$TMUX" ]]; then',
        '    tmux has-session -t claude 2>/dev/null && exec tmux attach -t claude',
        'fi',
        'EOF',
      ].join('\n'),
      'chown ec2-user:ec2-user /home/ec2-user/.bashrc',

      // ⑥ セットアップ完了マーカー
      'echo "CLAUDE_ON_EC2_SETUP_COMPLETE=$(date)" >> /home/ec2-user/.setup-complete',
      'chown ec2-user:ec2-user /home/ec2-user/.setup-complete',
    );

    // ── EC2 インスタンス ─────────────────────────────────
    const instance = new ec2.Instance(this, 'ClaudeEc2Instance', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,  // Graviton2（ARM64）
        ec2.InstanceSize.LARGE,
      ),
      // Amazon Linux 2023（ARM64版）
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      userData,
      // パブリックサブネット（SSM がインターネット経由で接続できるようにするため）
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      // EBS ボリューム: 30 GB gp3（暗号化あり）
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: false, // ← EC2 を terminate してもデータは残す
          }),
        },
      ],
    });

    // ── EC2 終了保護 ─────────────────────────────────────
    // 誤って cdk destroy や AWS コンソールから terminate するのを防ぐ
    // ⚠️ 削除時は先に AWS コンソールで「終了保護を無効化」する必要あり
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.disableApiTermination = true;

    // ── Elastic IP ────────────────────────────────────────
    // 固定 IP を割り当て（EC2 を再起動しても IP が変わらない）
    const eip = new ec2.CfnEIP(this, 'ClaudeEc2Eip', {
      tags: [{ key: 'Name', value: 'claude-on-ec2-eip' }],
    });
    new ec2.CfnEIPAssociation(this, 'ClaudeEc2EipAssociation', {
      instanceId: instance.instanceId,
      allocationId: eip.attrAllocationId,
    });

    // ── AWS Backup ────────────────────────────────────────
    // EBS のスナップショットを週1回取得（会話履歴・設定の保全用）
    const backupVault = new backup.BackupVault(this, 'ClaudeBackupVault', {
      backupVaultName: 'claude-on-ec2-backup',
      // スタック削除時もバックアップデータは残す（意図しないデータ消失を防ぐ）
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const backupPlan = new backup.BackupPlan(this, 'ClaudeBackupPlan', {
      backupVault: backupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'weekly-sunday-utc18',
          // 毎週日曜 UTC 18:00 = JST 月曜 03:00 に取得
          scheduleExpression: events.Schedule.cron({
            minute: '0',
            hour: '18',
            weekDay: 'SUN',
          }),
          // 4週分（30日）保持
          deleteAfter: cdk.Duration.days(30),
        }),
      ],
    });

    backupPlan.addSelection('ClaudeEc2BackupSelection', {
      resources: [backup.BackupResource.fromEc2Instance(instance)],
    });

    // ── タグ ──────────────────────────────────────────────
    cdk.Tags.of(instance).add('Name', 'claude-on-ec2');
    cdk.Tags.of(instance).add('Project', 'claude-on-ec2');

    // ── Outputs ───────────────────────────────────────────
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID（SSM Session Manager 接続に使用）',
    });
    new cdk.CfnOutput(this, 'ElasticIp', {
      value: eip.ref,
      description: 'Elastic IP アドレス（VSCode Remote-SSH 設定に使用）',
    });
    new cdk.CfnOutput(this, 'SsmConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: 'SSM Session Manager で接続するコマンド',
    });
  }
}
