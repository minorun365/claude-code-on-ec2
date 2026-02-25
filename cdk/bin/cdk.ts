#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ClaudeOnEc2Stack } from '../lib/claude-on-ec2-stack';

const app = new cdk.App();

new ClaudeOnEc2Stack(app, 'ClaudeOnEc2Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Claude Code を常時稼働させるための EC2 環境',
});
