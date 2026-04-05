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
    // アウトバウンドは全許可（SSM・Anthropic API 通信が必要）
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

      // ② Claude Code ネイティブインストール（Node.js 不要・直接インストール）
      // --noprofile --norc: .bashrc の tmux 自動アタッチが非対話型環境で干渉するのを防ぐ
      'sudo -u ec2-user bash --noprofile --norc -c "export HOME=/home/ec2-user && curl -fsSL https://claude.ai/install.sh | bash"',

      // ③ ec2-user ログイン時は既存の tmux セッションに自動アタッチ + ヘルパー関数
      [
        "if ! grep -q 'claude-on-ec2 auto attach' /home/ec2-user/.bashrc 2>/dev/null; then",
        "cat >> /home/ec2-user/.bashrc << 'BASHEOF'",
        '',
        '# claude-on-ec2 auto attach',
        'export PATH="$HOME/.local/bin:$PATH"',
        'export TERM=xterm-256color',
        'if [[ $- == *i* ]] && [[ -z "$TMUX" ]] && command -v tmux >/dev/null 2>&1; then',
        '  tmux has-session -t claude 2>/dev/null && exec tmux attach -t claude',
        'fi',
        '',
        '# cw: Claude Workspace - 指定ディレクトリで Claude Code を起動',
        '# 使い方: cw ~/git/my-project',
        '#         cw  (引数なし = ホームで起動)',
        'cw() {',
        '  local dir="${1:-$HOME}"',
        '  if [[ -d "$dir" ]]; then',
        '    cd "$dir" && claude',
        '  else',
        '    echo "Directory not found: $dir"',
        '  fi',
        '}',
        'BASHEOF',
        'fi',
      ].join('\n'),
      'chown ec2-user:ec2-user /home/ec2-user/.bashrc',

      // ④ Claude Code エントリポイント（終了後はbashに落ちてワークスペース変更可能）
      [
        "cat > /usr/local/bin/claude-entrypoint.sh << 'ENTRYEOF'",
        '#!/bin/bash',
        'export HOME=/home/ec2-user',
        'export PATH="$HOME/.local/bin:$PATH"',
        'export TERM=xterm-256color',
        'cd /home/ec2-user',
        'echo "=== Claude Code on EC2 ==="',
        'echo "Starting Claude Code..."',
        'echo "After login, run /config to enable Remote Control."',
        'echo ""',
        'claude || true',
        'echo ""',
        'echo "=== Claude Code exited ==="',
        'echo "You can now:"',
        'echo "  - Run: claude                  (restart here)"',
        'echo "  - Run: cw ~/git/my-project     (change workspace)"',
        'echo "  - Run: exit                    (close this pane)"',
        'echo ""',
        'exec bash -l',
        'ENTRYEOF',
      ].join('\n'),
      'chmod +x /usr/local/bin/claude-entrypoint.sh',

      // ⑤ tmux + Claude Code 自動起動スクリプト（pane-died フック廃止 = 無限ループ根絶）
      [
        "cat > /usr/local/bin/claude-autostart.sh << 'AUTOSTARTEOF'",
        '#!/bin/bash',
        'export HOME=/home/ec2-user',
        'export PATH="$HOME/.local/bin:$PATH"',
        'export TERM=xterm-256color',
        '# 既存セッションがなければ新規作成',
        'if ! tmux has-session -t claude 2>/dev/null; then',
        '  tmux kill-server 2>/dev/null || true',
        '  sleep 0.5',
        '  tmux new-session -d -s claude -x 220 -y 50 "/usr/local/bin/claude-entrypoint.sh"',
        'fi',
        'AUTOSTARTEOF',
      ].join('\n'),
      'chmod +x /usr/local/bin/claude-autostart.sh',

      // ⑥ systemd サービス登録（初回起動時にも即実行）
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
      'systemctl start claude-code.service',

      // ⑦ セットアップ完了マーカー
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
