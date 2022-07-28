import {
    CreateMysqlCredentials,
    ParseError,
    WarehouseTypes,
} from '@lightdash/common';
import { JSONSchemaType } from 'ajv';
import betterAjvErrors from 'better-ajv-errors';
import { ajv } from '../../ajv';
import { Target } from '../types';

export type MysqlTarget = {
    type: 'mysql';

    server?: string;
    host?: string;

    port: number;

    username: string;
    password?: string;
    pass?: string;

    schema?: string;
    database?: string;

    enableKeepAlive: boolean;
    keepAliveInitialDelay?: number;
    sslmode?: string;
    // threads: number; not supported in community version
};

export const mysqlSchema: JSONSchemaType<MysqlTarget> = {
    type: 'object',
    properties: {
        type: {
            type: 'string',
            enum: ['mysql'],
        },
        server: {
            type: 'string',
            nullable: true,
        },
        host: {
            type: 'string',
            nullable: true,
        },
        username: {
            type: 'string',
        },
        port: {
            type: 'integer',
        },
        database: {
            type: 'string',
            nullable: true,
        },
        schema: {
            type: 'string',
            nullable: true,
        },
        pass: {
            type: 'string',
            nullable: true,
        },
        password: {
            type: 'string',
            nullable: true,
        },
        keepAliveInitialDelay: {
            type: 'integer',
            nullable: true,
        },
        enableKeepAlive: {
            type: 'boolean',
            nullable: true,
            default: false,
        },
        sslmode: {
            type: 'string',
            nullable: true,
        },
    },
    required: ['type', 'username', 'port'],
};

export const convertMysqlSchema = (target: Target): CreateMysqlCredentials => {
    const validate = ajv.compile<MysqlTarget>(mysqlSchema);
    if (validate(target)) {
        const password = target.pass || target.password;
        if (!password) {
            throw new ParseError(
                `Mysql target requires a password: "password"`,
            );
        }
        const host = target.host || target.server; // target contains the host name as server
        if (!host) {
            throw new ParseError(
                `Mysql target requires a host: "host or server"`,
            );
        }
        const dbname = target.database || target.schema;
        if (!dbname) {
            throw new ParseError(
                `Mysql target requires a database or schema name: "database or schema"`,
            );
        }
        return {
            type: WarehouseTypes.MYSQL,
            host,
            user: target.username,
            password,
            port: target.port,
            schema: dbname,
            enableKeepAlive: target.enableKeepAlive,
            keepAliveInitialDelay: target.keepAliveInitialDelay,
            sslmode: target.sslmode,
        };
    }
    const errs = betterAjvErrors(mysqlSchema, target, validate.errors || []);
    throw new ParseError(
        `Couldn't read profiles.yml file for ${target.type}:\n${errs}`,
    );
};
