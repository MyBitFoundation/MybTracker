import "reflect-metadata";
import { createConnection } from "typeorm";
import { MyBEvent } from "./entity/MybEvent/MybEvent";
import { MybTransaction } from "./entity/MybTransaction/MybTransaction";
import { ethers } from "ethers";
import { APIGatewayProxyEvent } from "aws-lambda";
import cryptoRandomString = require("crypto-random-string");

interface Response {
  statusCode: number;
  body: string;
  headers: object;
}

const lockAddresses = [
  "0xd9d2b28e09921a38ad7ab1b4138357408bda8ebd",
  "0xcca36039cfdd0753d3aa9f1b4bf35b606c8ed971",
  "0xfd1e4b568bb3bcf706b0bac5960d4b91bacff96f",
  "0x7389c003988802a713af73e82777b1c702077c6f",
  "0x7dc8a6e706da7c4a77d3710f7b7e621ee0074dc3",
  "0xc7e7790fc0c81a2d880b1e119ba0921881f0cdef"
];

let options: any = {
  type: "mysql",
  host: process.env.TYPEORM_HOST,
  port: parseInt(process.env.TYPEORM_PORT as string),
  username: process.env.TYPEORM_USERNAME,
  password: process.env.TYPEORM_PASSWORD,
  database: process.env.TYPEORM_DATABASE,
  synchronize: true,
  logging: false,
  entities: [MybTransaction, MyBEvent]
};

exports.APIHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  let response: Response;
  options.name = cryptoRandomString({ length: 6, type: 'hex'})
  let connection
  try {
    connection = await createConnection(options)
    const repository = connection.getRepository(MybTransaction);
    let query = event.queryStringParameters!.to
      ? repository.createQueryBuilder("tx").where("tx.to = :to", {
          to: ethers.utils.getAddress(event.queryStringParameters!.to)
        })
      : repository.createQueryBuilder("tx");
    const txs = await query
      .orderBy({ "tx.blockNumber": "DESC" })
      .skip(parseInt(event.queryStringParameters!.skip, 10))
      .take(parseInt(event.queryStringParameters!.take, 10))
      .leftJoinAndSelect("tx.events", "event")
      .getMany();
    response = {
      statusCode: 200,
      body: JSON.stringify(txs),
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  } catch (e) {
    console.log(e);
    response = {
      statusCode: 500,
      body: JSON.stringify(e),
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  } finally {
    connection.close();
  }
  return response;
};

exports.GraphHandler = async (): Promise<any> => {
  let response: Response;
  options.name = cryptoRandomString({ length: 6, type: 'hex'})
  let connection;
  try {
    connection = await createConnection(options)
    const repository = connection.getRepository(MyBEvent);
    const locked = await repository
      .createQueryBuilder("evt")
      .where("evt.isLock = :lock", {
        lock: true
      })
      .getMany();

    const burnt = await repository
      .createQueryBuilder("mevt")
      .where("mevt.p1 = :burnaddr", {
        burnaddr: "0x0000000000000000000000000000000000000000"
      })
      .getMany();
    response = {
      statusCode: 200,
      body: JSON.stringify(
        locked.concat(burnt).sort((a, b) => a.blockNumber - b.blockNumber)
      ),
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  } catch (e) {
    console.log(e);
    response = {
      statusCode: 500,
      body: JSON.stringify(e),
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  } finally {
    connection.close();
  }
  return response;
};

exports.handler = async () => {
  options.name = cryptoRandomString({ length: 6, type: 'hex'})
  console.log("start");
  let connection;
  try {
    connection = await createConnection(options)
    const provider = new ethers.providers.InfuraProvider(
      "mainnet",
      "0089c84cfe00443396a7a0cb856eb08a"
    );
    const tokenContract = new ethers.Contract(
      "0x5d60d8d7eF6d37E16EBABc324de3bE57f135e0BC",
      ABI,
      provider
    );
    const eventsContract = new ethers.Contract(
      "0xF7851BDa500a48fA7c213FE3B0de8602e5CD6B6f",
      eventsABI,
      provider
    );
    const repository = connection.getRepository(MybTransaction);
    console.log("repository");
    let lastEntry: void | MybTransaction = await repository
      .createQueryBuilder("myBTransaction")
      .orderBy({ "myBTransaction.blockNumber": "DESC" })
      .limit(1)
      .getOne()
      .catch(console.log);
    const lastBlock = lastEntry ? lastEntry.blockNumber + 1 : 5573385;
    console.log(lastBlock);
    const currentBlock = await provider.getBlockNumber();
    let tokenEvents: any = await tokenContract.provider.getLogs({
      fromBlock: lastBlock,
      toBlock: lastBlock + 75000 < currentBlock ? lastBlock + 75000 : "latest",
      address: tokenContract.address
    });
    tokenEvents = tokenEvents.map(e => {
      try {
        e.parsed = tokenContract.interface.parseLog(e);
      } catch (err) {
        e.parsed = { values: ["0x", "0x", "0x", "0x"], name: "Unknown event" };
      }

      return e;
    });
    let otherEvents: any = await eventsContract.provider.getLogs({
      fromBlock: lastBlock,
      toBlock: lastBlock + 75000 < currentBlock ? lastBlock + 75000 : "latest",
      address: eventsContract.address
    });
    otherEvents = otherEvents.map(e => {
      try {
        e.parsed = eventsContract.interface.parseLog(e);
      } catch (err) {
        e.parsed = { values: ["0x", "0x", "0x", "0x"], name: "Unknown event" };
      }
      return e;
    });

    const events = tokenEvents.concat(otherEvents);
    const savedLogs: any = await Promise.all(
      events.map(async event => {
        const log = new MyBEvent();
        log.name = event.parsed.name;
        log.p0 = event.parsed.values[0];
        log.p1 = event.parsed.values[1];
        log.p2 = ethers.utils.formatEther(event.parsed.values[2]);
        log.p3 = event.parsed.values[3];
        log.blockNumber = event.blockNumber as number;
        const block = await provider.getBlock(event.blockHash as string);
        log.timestamp = block.timestamp as number;
        log.hash = event.transactionHash as string;
        if (
          lockAddresses.findIndex(
            e =>
              e === event.parsed.values[0].toLowerCase() &&
              event.parsed.name == "Transfer"
          ) !== -1 ||
          lockAddresses.findIndex(
            e =>
              e === event.parsed.values[1].toLowerCase() &&
              event.parsed.name == "Transfer"
          ) !== -1
        ) {
          log.isLock = true;
        }
        await connection.manager.save(log).catch(e => {
          console.log(e);
          connection.close();
        });
        return log;
      })
    );
    await Promise.all(
      Array.from(new Set(savedLogs.map((log: any) => log.hash))).map(
        async (txHash: any) => {
          const tx = await provider.getTransaction(txHash);
          let mybTx = new MybTransaction() as any;
          mybTx.blockHash = tx.blockHash!;
          mybTx.blockNumber = tx.blockNumber!;
          mybTx.data = tx.data;
          mybTx.from = tx.from;
          mybTx.to = tx.to ? tx.to : "0x";
          mybTx.value = ethers.utils.formatEther(tx.value);
          mybTx.gasPrice = ethers.utils.formatEther(tx.gasPrice);
          mybTx.gasLimit = tx.gasLimit.toString();
          mybTx.nonce = tx.nonce;
          mybTx.hash = tx.hash;
          mybTx.events = savedLogs.filter(l => l.hash === tx.hash);
          await connection.manager.save(mybTx).catch(e => {
            console.log(e);
            connection.close();
          })
        }
      )
    );
  } catch (e) {
    console.log(e);
  } finally {
    connection.close();
  }
};

const ABI = [
  {
    constant: true,
    inputs: [],
    name: "name",
    outputs: [
      {
        name: "",
        type: "string"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0x06fdde03"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_spender",
        type: "address"
      },
      {
        name: "_value",
        type: "uint256"
      }
    ],
    name: "approve",
    outputs: [
      {
        name: "",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x095ea7b3"
  },
  {
    constant: true,
    inputs: [],
    name: "totalSupply",
    outputs: [
      {
        name: "",
        type: "uint256"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0x18160ddd"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_from",
        type: "address"
      },
      {
        name: "_to",
        type: "address"
      },
      {
        name: "_value",
        type: "uint256"
      }
    ],
    name: "transferFrom",
    outputs: [
      {
        name: "",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x23b872dd"
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [
      {
        name: "",
        type: "uint8"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0x313ce567"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_amount",
        type: "uint256"
      }
    ],
    name: "burn",
    outputs: [
      {
        name: "success",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x42966c68"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_spender",
        type: "address"
      },
      {
        name: "_subtractedValue",
        type: "uint256"
      }
    ],
    name: "decreaseApproval",
    outputs: [
      {
        name: "",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x66188463"
  },
  {
    constant: true,
    inputs: [
      {
        name: "_owner",
        type: "address"
      }
    ],
    name: "balanceOf",
    outputs: [
      {
        name: "",
        type: "uint256"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0x70a08231"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_from",
        type: "address"
      },
      {
        name: "_amount",
        type: "uint256"
      }
    ],
    name: "burnFrom",
    outputs: [
      {
        name: "success",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x79cc6790"
  },
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [
      {
        name: "",
        type: "string"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0x95d89b41"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_to",
        type: "address"
      },
      {
        name: "_value",
        type: "uint256"
      }
    ],
    name: "transfer",
    outputs: [
      {
        name: "",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0xa9059cbb"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_spender",
        type: "address"
      },
      {
        name: "_addedValue",
        type: "uint256"
      }
    ],
    name: "increaseApproval",
    outputs: [
      {
        name: "",
        type: "bool"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0xd73dd623"
  },
  {
    constant: true,
    inputs: [
      {
        name: "_owner",
        type: "address"
      },
      {
        name: "_spender",
        type: "address"
      }
    ],
    name: "allowance",
    outputs: [
      {
        name: "",
        type: "uint256"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0xdd62ed3e"
  },
  {
    inputs: [
      {
        name: "_tokenURI",
        type: "string"
      },
      {
        name: "_symbol",
        type: "string"
      },
      {
        name: "_totalSupply",
        type: "uint256"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "constructor",
    signature: "constructor"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: "_spender",
        type: "address"
      },
      {
        indexed: false,
        name: "_value",
        type: "uint256"
      }
    ],
    name: "LogBurn",
    type: "event",
    signature:
      "0x38d762ef507761291a578e921acfe29c1af31a7331ea03e391cf16cfc4d4f581"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: "from",
        type: "address"
      },
      {
        indexed: true,
        name: "to",
        type: "address"
      },
      {
        indexed: false,
        name: "value",
        type: "uint256"
      }
    ],
    name: "Transfer",
    type: "event",
    signature:
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: "owner",
        type: "address"
      },
      {
        indexed: true,
        name: "spender",
        type: "address"
      },
      {
        indexed: false,
        name: "value",
        type: "uint256"
      }
    ],
    name: "Approval",
    type: "event",
    signature:
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
  }
];

const eventsABI = [
  {
    constant: true,
    inputs: [],
    name: "database",
    outputs: [
      {
        name: "",
        type: "address"
      }
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
    signature: "0x713b563f"
  },
  {
    inputs: [
      {
        name: "_database",
        type: "address"
      }
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "constructor",
    signature: "constructor"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogEvent",
    type: "event",
    signature:
      "0xa8fda057da710952fe2bd7579ffe2fa1a9d238fa2b39323e63c15e289b543ec7"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "from",
        type: "address"
      },
      {
        indexed: true,
        name: "to",
        type: "address"
      },
      {
        indexed: false,
        name: "amount",
        type: "uint256"
      },
      {
        indexed: false,
        name: "token",
        type: "address"
      },
      {
        indexed: false,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogTransaction",
    type: "event",
    signature:
      "0xfd80b0499d466e5ceb1521c31d86643e06e1390bd7486aef7fe8a958080b0855"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "account",
        type: "address"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogAddress",
    type: "event",
    signature:
      "0xa52a36e76b500c0aeee4e1ea9b294f833a0eba932f01d75395c9ae1aba0a9659"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "account",
        type: "address"
      },
      {
        indexed: false,
        name: "name",
        type: "string"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogContractChange",
    type: "event",
    signature:
      "0xcd9a484b17c708d85e899f6e3f0c8d521fa38d58604427b1d7a3558d2bd0830b"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "uri",
        type: "string"
      },
      {
        indexed: true,
        name: "assetID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "asset",
        type: "address"
      },
      {
        indexed: false,
        name: "manager",
        type: "address"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogAsset",
    type: "event",
    signature:
      "0x81e3988b2d4a535c38a8d0bb25f1bf3fc0fae4304f13292258c80460d319048f"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "asset",
        type: "address"
      },
      {
        indexed: false,
        name: "escrowID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "manager",
        type: "address"
      },
      {
        indexed: false,
        name: "amount",
        type: "uint256"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogEscrow",
    type: "event",
    signature:
      "0x100520eaf70b22f938253d35fcecbe5ec21f686f938e02f6553318b52efd2ffe"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "orderID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "amount",
        type: "uint256"
      },
      {
        indexed: false,
        name: "price",
        type: "uint256"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogOrder",
    type: "event",
    signature:
      "0xbfd5c7f40f17c3c4d259746f658e50128286dce2f2a2d374e235b7e4b8055731"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "orderID",
        type: "bytes32"
      },
      {
        indexed: true,
        name: "asset",
        type: "address"
      },
      {
        indexed: false,
        name: "account",
        type: "address"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogExchange",
    type: "event",
    signature:
      "0x527c6cf635c1aee21fa60d2f756d9553f7129cbf27cd3bec6137fd2033a62d8a"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "operatorID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "operatorURI",
        type: "string"
      },
      {
        indexed: true,
        name: "account",
        type: "address"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogOperator",
    type: "event",
    signature:
      "0xd6426a3ba1f4047d5121b172d5742f9de82fb88d3893b3fb3c5a665ef4bf96f1"
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        name: "message",
        type: "string"
      },
      {
        indexed: true,
        name: "messageID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "executionID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "votesID",
        type: "bytes32"
      },
      {
        indexed: false,
        name: "votes",
        type: "uint256"
      },
      {
        indexed: false,
        name: "tokens",
        type: "uint256"
      },
      {
        indexed: false,
        name: "quorum",
        type: "uint256"
      },
      {
        indexed: true,
        name: "origin",
        type: "address"
      }
    ],
    name: "LogConsensus",
    type: "event",
    signature:
      "0x88d1e51c02fdc70db34224fee44c315527d4bc0da934e23b0fd6c06376400a32"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      }
    ],
    name: "message",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x05c766d1"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_from",
        type: "address"
      },
      {
        name: "_to",
        type: "address"
      },
      {
        name: "_amount",
        type: "uint256"
      },
      {
        name: "_token",
        type: "address"
      }
    ],
    name: "transaction",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x42b425aa"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_account",
        type: "address"
      }
    ],
    name: "registration",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0xbb39cc3c"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_account",
        type: "address"
      },
      {
        name: "_name",
        type: "string"
      }
    ],
    name: "contractChange",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0xf5ade840"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_uri",
        type: "string"
      },
      {
        name: "_assetAddress",
        type: "address"
      },
      {
        name: "_manager",
        type: "address"
      }
    ],
    name: "asset",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x78576a91"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_assetAddress",
        type: "address"
      },
      {
        name: "_escrowID",
        type: "bytes32"
      },
      {
        name: "_manager",
        type: "address"
      },
      {
        name: "_amount",
        type: "uint256"
      }
    ],
    name: "escrow",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x0b94df4c"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_orderID",
        type: "bytes32"
      },
      {
        name: "_amount",
        type: "uint256"
      },
      {
        name: "_price",
        type: "uint256"
      }
    ],
    name: "order",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0xa1c0aafe"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_orderID",
        type: "bytes32"
      },
      {
        name: "_assetAddress",
        type: "address"
      },
      {
        name: "_account",
        type: "address"
      }
    ],
    name: "exchange",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0xe609295c"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_operatorID",
        type: "bytes32"
      },
      {
        name: "_operatorURI",
        type: "string"
      },
      {
        name: "_account",
        type: "address"
      }
    ],
    name: "operator",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x1dc071aa"
  },
  {
    constant: false,
    inputs: [
      {
        name: "_message",
        type: "string"
      },
      {
        name: "_executionID",
        type: "bytes32"
      },
      {
        name: "_votesID",
        type: "bytes32"
      },
      {
        name: "_votes",
        type: "uint256"
      },
      {
        name: "_tokens",
        type: "uint256"
      },
      {
        name: "_quorum",
        type: "uint256"
      }
    ],
    name: "consensus",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
    signature: "0x01e375c6"
  }
];
