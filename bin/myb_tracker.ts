#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/cdk');
import { MybTrackerStack } from '../lib/myb_tracker-stack';

const app = new cdk.App();
new MybTrackerStack(app, 'TrackerStack2', { env: { region: 'us-east-1' }});

