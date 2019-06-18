import cdk = require("@aws-cdk/cdk");
import lambda = require("@aws-cdk/aws-lambda");
import apigateway = require("@aws-cdk/aws-apigateway");
import events = require("@aws-cdk/aws-events");
import iam = require("@aws-cdk/aws-iam");
import ec2 = require("@aws-cdk/aws-ec2");
import rds =require("@aws-cdk/aws-rds");
import { SecretValue } from "@aws-cdk/cdk";
export class MybTrackerStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pass = process.env.DB_PASS

    const role = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
    });
    role.attachManagedPolicy(
      "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
    );

    const code = lambda.Code.asset("TxDatabase");

    const vpc = new ec2.VpcNetwork(this, "VPC");

    const passw = SecretValue.plainText(pass)

    const cluster = new rds.DatabaseCluster(this, "MyRdsDb", {
      defaultDatabaseName: "txdb",
      masterUser: {
        username: "dbuser",
        password: passw
      },
      engine: rds.DatabaseClusterEngine.Aurora,
      instances: 1,
      instanceProps: {
        instanceType: new ec2.InstanceType('t3.small'),
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.Public
        }
      },
    });

    const environment = {
      TYPEORM_CONNECTION: "mysql",
      TYPEORM_HOST: cluster.clusterEndpoint.hostname,
      TYPEORM_USERNAME: "dbuser",
      TYPEORM_PASSWORD: pass,
      TYPEORM_DATABASE: "txdb",
      TYPEORM_PORT: cluster.clusterEndpoint.port,
      TYPEORM_SYNCHRONIZE: "true",
      TYPEORM_LOGGING: "true",
      TYPEORM_ENTITIES: "src/**/*.js"
    }


    cluster.connections.allowDefaultPortFromAnyIpv4('Open to the world');
    
    const UpdateDatabaseFn = new lambda.Function(this, "UpdateDatabaseFn", {
      runtime: lambda.Runtime.NodeJS810,
      handler: "index.handler",
      code: code,
      role: role,
      memorySize: 512,
      timeout: 400,
      environment
    });

    const UpdateDatabaseRule = new events.EventRule(
      this,
      "UpdateDatabaseRule",
      {
        scheduleExpression: "rate(2 minutes)"
      }
    );
    UpdateDatabaseRule.addTarget(UpdateDatabaseFn);


    const getGraphFn = new lambda.Function(this, "GetGraphFn", {
      runtime: lambda.Runtime.NodeJS810,
      handler: "index.GraphHandler",
      code: code,
      role: role,
      memorySize: 256,
      timeout: 150,
      environment
    });

    const getGraphEndpoint = new apigateway.LambdaRestApi(
      this,
      "GetGraphEndpoint",
      {
        handler: getGraphFn
      }
    );
    getGraphEndpoint.export();

    const getTxsFn = new lambda.Function(this, "GetTxsFn", {
      runtime: lambda.Runtime.NodeJS810,
      handler: "index.APIHandler",
      code: code,
      role: role,
      memorySize: 256,
      timeout: 150,
      environment
    });

    const getTxsEndpoint = new apigateway.LambdaRestApi(
      this,
      "GetTxsEndpoint",
      {
        handler: getTxsFn
      }
    );
    getTxsEndpoint.export();
  }
}
