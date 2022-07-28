import { DimensionType } from '@lightdash/common';
import { FieldPacket } from 'mysql2';

export type WarehouseTableSchema = {
    [column: string]: DimensionType;
};
export type WarehouseCatalog = {
    [database: string]: {
        [schema: string]: {
            [table: string]: WarehouseTableSchema;
        };
    };
};

export interface WarehouseClient {
    getCatalog: (
        config: {
            database: string;
            schema: string;
            table: string;
        }[],
    ) => Promise<WarehouseCatalog>;

    runQuery(sql: string): Promise<{
        fields: Record<string, { type: DimensionType }>;
        rows: Record<string, any>[];
    }>;

    test(): Promise<void>;
}

export interface MysqlFieldPacketWithColumnType extends FieldPacket {
    columnType: number;
}
