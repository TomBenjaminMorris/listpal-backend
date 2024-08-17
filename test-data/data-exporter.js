import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import * as fs from 'node:fs';

const client = new DynamoDBClient({ region: "eu-west-2" });
const input = {
    TableName: "ListPal-Dev",
};

const command = new ScanCommand(input);
const response = await client.send(command);
const data = response.Items.map((item) => {
    return unmarshall(item);
});

const date = new Date()
fs.writeFile(`./exports/ListPal-Dev-Test-Data-${date.toISOString().split('T')[0]}.json`, JSON.stringify(data, null, 2), err => {
    if (err) {
        console.error(err);
    } else {
    }
});
