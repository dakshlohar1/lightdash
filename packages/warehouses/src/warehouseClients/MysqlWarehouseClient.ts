import * as mysqlTypings from 'mysql'; 
import * as mysql2 from 'mysql2'; 
import {
    CreateMysqlCredentials,
    DimensionType,
    WarehouseConnectionError,
    WarehouseQueryError,
} from '@lightdash/common';
import { MysqlFieldPacketWithColumnType, WarehouseClient } from '../types';

// Enum for all mysql data types https://dev.mysql.com/doc/refman/8.0/en/data-types.html
export enum MysqlTypes {
    BIT = 'bit',
    TINYINT = 'tinyint',
    SMALLINT = 'smallint',
    MEDIUMINT = 'mediumint',
    BIGINT = 'bigint',
    SERIAL = 'serial',
    INT = 'int',
    INT2 = 'int2',
    INT4 = 'int4',
    INT8 = 'int8',
    INTEGER = 'integer',
    FLOAT = 'float',
    FLOAT4 = 'float4',
    FLOAT8 = 'float8',
    DOUBLE = 'double',
    DOUBLE_PRECISION = 'double precision',
    DECIMAL = 'decimal',
    REAL = 'real',
    NUMERIC = 'numeric',

    DATE = 'date',
    DATETIME = 'datetime',
    TIMESTAMP = 'timestamp',
    TIME = 'time',
    YEAR = 'year',

    NCHAR = 'nchar',
    VARCHAR = 'varchar',
    BINARY = 'binary',
    BLOB = 'blob',
    JSON = 'json',
    CHAR = 'char',
    CHARACTER = 'character',
    TEXT = 'text',
    SET = 'set',
    BOOLEAN = 'boolean',
    BOOL = 'bool',
}

const mapFieldType = (type: string): DimensionType => {
    switch (type) {
        case MysqlTypes.BIT:
        case MysqlTypes.DECIMAL:
        case MysqlTypes.TINYINT:
        case MysqlTypes.NUMERIC:
        case MysqlTypes.MEDIUMINT:
        case MysqlTypes.INTEGER:
        case MysqlTypes.SERIAL:
        case MysqlTypes.INT:
        case MysqlTypes.INT2:
        case MysqlTypes.INT4:
        case MysqlTypes.INT8:
        case MysqlTypes.BIGINT:
        case MysqlTypes.SMALLINT:
        case MysqlTypes.FLOAT:
        case MysqlTypes.FLOAT4:
        case MysqlTypes.FLOAT8:
        case MysqlTypes.DOUBLE_PRECISION:
        case MysqlTypes.DOUBLE:
        case MysqlTypes.REAL:
        case MysqlTypes.BOOLEAN: // FIXME: this is not a valid type in mysql
        case MysqlTypes.BOOL:
            return DimensionType.NUMBER;
        case MysqlTypes.DATE:
        case MysqlTypes.DATETIME:
        case MysqlTypes.YEAR:
            return DimensionType.DATE;

        case MysqlTypes.TIME:
        case MysqlTypes.TIMESTAMP:
            return DimensionType.TIMESTAMP;
        default:
            return DimensionType.STRING;
    }
};

const { Types: builtins } = mysqlTypings;
const convertDataTypeIdToDimensionType = (
    dataTypeId: number,
): DimensionType => {
    switch (dataTypeId) {
        case builtins.BIT:
        case builtins.DECIMAL:
        case builtins.DOUBLE:
        case builtins.FLOAT:
        case builtins.NEWDECIMAL:
        case builtins.INT24:
            return DimensionType.NUMBER;
        case builtins.DATE:
        case builtins.NEWDATE:
        case builtins.DATETIME:
        case builtins.DATETIME2:
        case builtins.TIME:
        case builtins.TIME2:
        case builtins.YEAR:
            return DimensionType.DATE;
        case builtins.TIME:
        case builtins.TIMESTAMP:
            return DimensionType.TIMESTAMP;
        // case builtins.BOOL:
        //     return DimensionType.BOOLEAN;
        default:
            return DimensionType.STRING;
    }
};

export class MysqlClient implements WarehouseClient {
    pool: mysql2.Pool;

    constructor(config: mysql2.PoolOptions) {
        try {
            const pool = mysql2.createPool(config);
            this.pool = pool;
        } catch (e) {
            throw new WarehouseConnectionError((e as Error).message);
        }
    }

    runQuery(sql: string) {
        try {
            const queryResult = new Promise<{
                fields: Record<string, { type: DimensionType }>;
                rows: Record<string, any>[];
            }>((resolve, reject) => {
                this.pool.query(sql, (error, result, fields) => {
                    if (error) {
                        reject(new WarehouseQueryError(error.message));
                    }
                    const attributes = (
                        fields as MysqlFieldPacketWithColumnType[]
                    ).reduce(
                        (acc, { name, columnType }) => ({
                            ...acc,
                            [name]: {
                                type: convertDataTypeIdToDimensionType(
                                    //TODO: there might be an issue
                                    columnType,
                                ),
                            },
                        }),
                        {},
                    );
                    resolve({
                        fields: attributes,
                        rows: result as Record<string, any>[],
                    }); //FIXME: fix this type casting
                });
            });

            return queryResult;
        } catch (e) {
            throw new WarehouseQueryError((e as Error).message);
        }
    }

    async test(): Promise<void> {
        await this.runQuery('SELECT 1');
    }

    async getCatalog(
        requests: {
            database: string;
            schema: string;
            table: string;
        }[],
    ) {
        const { databases, schemas, tables } = requests.reduce<{
            databases: Set<string>;
            schemas: Set<string>;
            tables: Set<string>;
        }>(
            (acc, { database, schema, table }) => ({
                databases: acc.databases.add(`'${database}'`),
                schemas: acc.schemas.add(`'${schema}'`),
                tables: acc.tables.add(`'${table}'`),
            }),
            {
                databases: new Set(),
                schemas: new Set(),
                tables: new Set(),
            },
        );
        if (databases.size <= 0 || schemas.size <= 0 || tables.size <= 0) {
            return {};
        }
        const query = `
            SELECT table_catalog,
                   table_schema,
                   table_name,
                   column_name,
                   data_type
            FROM information_schema.columns
            WHERE table_schema IN (${
                Array.from(schemas) || Array.from(databases)
            })
            AND table_name IN (${Array.from(tables)})
        `;
        //TODO: Check for the upper OR condition

        const { rows } = await this.runQuery(query);
        const catalog = rows.reduce(
            (
                acc,
                {
                    table_catalog,
                    table_schema,
                    table_name,
                    column_name,
                    data_type,
                },
            ) => {
                const match = requests.find(
                    ({ database, schema, table }) =>
                        database === table_catalog &&
                        schema === table_schema &&
                        table === table_name,
                );
                if (match) {
                    acc[table_catalog] = acc[table_catalog] || {};
                    acc[table_catalog][table_schema] =
                        acc[table_catalog][table_schema] || {};
                    acc[table_catalog][table_schema][table_name] =
                        acc[table_catalog][table_schema][table_name] || {};
                    acc[table_catalog][table_schema][table_name][column_name] =
                        mapFieldType(data_type);
                }

                return acc;
            },
            {},
        );
        return catalog;
    }
}

export class MysqlWarehouseClient
    extends MysqlClient
    implements WarehouseClient
{
    constructor(credentials: CreateMysqlCredentials) {
        super({
            host: credentials.host,
            user: credentials.user,
            password: credentials.password,
            database: credentials.schema, // Mysql uses the schema as the database
            port: credentials.port,
            ssl: credentials.sslmode || 'PREFERRED',
            enableKeepAlive: credentials.enableKeepAlive || undefined,
            keepAliveInitialDelay: credentials.keepAliveInitialDelay,
        });
    }
}
