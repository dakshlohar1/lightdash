import {
    buildModelGraph,
    convertMetric,
    DbtMetric,
    DbtModelColumn,
    DbtModelNode,
    LineageGraph,
    SupportedDbtAdapter,
} from '../types/dbt';
import { MissingCatalogEntryError, ParseError } from '../types/errors';
import { Explore, ExploreError, Table } from '../types/explore';
import {
    defaultSql,
    Dimension,
    DimensionType,
    FieldType,
    friendlyName,
    Metric,
    MetricType,
    parseMetricType,
    Source,
} from '../types/field';
import { compileExplore } from './exploreCompiler';

const getDataTruncSql = (
    adapterType: SupportedDbtAdapter,
    timeInterval: string,
    field: string,
    type: DimensionType,
) => {
    switch (adapterType) {
        case SupportedDbtAdapter.BIGQUERY:
            if (type === DimensionType.TIMESTAMP) {
                return `DATETIME_TRUNC(${field}, ${timeInterval.toUpperCase()})`;
            }
            return `DATE_TRUNC(${field}, ${timeInterval.toUpperCase()})`;
        case SupportedDbtAdapter.SNOWFLAKE:
            return `TO_TIMESTAMP_NTZ(DATE_TRUNC('${timeInterval.toUpperCase()}', CONVERT_TIMEZONE('UTC', ${field})))`;
        case SupportedDbtAdapter.REDSHIFT:
        case SupportedDbtAdapter.POSTGRES:
        case SupportedDbtAdapter.DATABRICKS:
            return `DATE_TRUNC('${timeInterval.toUpperCase()}', ${field})`;
        case SupportedDbtAdapter.MYSQL:
            return `EXTRACT(${timeInterval.toUpperCase()} FROM ${field})`;
        default:
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const never: never = adapterType;
            throw new ParseError(`Cannot recognise warehouse ${adapterType}`);
    }
};

const dateIntervals = ['DAY', 'WEEK', 'MONTH', 'YEAR'];

const convertDimension = (
    targetWarehouse: SupportedDbtAdapter,
    model: Pick<DbtModelNode, 'name' | 'relation_name'>,
    tableLabel: string,
    column: DbtModelColumn,
    source?: Source,
    timeInterval?: string,
): Dimension => {
    let type =
        column.meta.dimension?.type || column.data_type || DimensionType.STRING;
    if (!Object.values(DimensionType).includes(type)) {
        throw new MissingCatalogEntryError(
            `Could not recognise type "${type}" for dimension "${
                column.name
            }" in dbt model "${model.name}". Valid types are: ${Object.values(
                DimensionType,
            ).join(', ')}`,
            {},
        );
    }
    let group: string | undefined;
    let name = column.meta.dimension?.name || column.name;
    let sql = column.meta.dimension?.sql || defaultSql(column.name);
    let label = column.meta.dimension?.label || friendlyName(name);
    if (timeInterval) {
        if (timeInterval !== 'RAW') {
            sql = getDataTruncSql(targetWarehouse, timeInterval, sql, type);
        }
        name = `${column.name}_${timeInterval.toLowerCase()}`;
        label = `${label} ${timeInterval.toLowerCase()}`;
        group = column.name;
        if (dateIntervals.includes(timeInterval.toUpperCase())) {
            type = DimensionType.DATE;
        }
    }
    return {
        fieldType: FieldType.DIMENSION,
        name,
        label,
        sql,
        table: model.name,
        tableLabel,
        type,
        description: column.meta.dimension?.description || column.description,
        source,
        group,
        timeInterval,
        hidden: !!column.meta.dimension?.hidden,
        format: column.meta.dimension?.format,
        round: column.meta.dimension?.round,
        groupLabel: column.meta.dimension?.group_label,
    };
};

const generateTableLineage = (
    model: DbtModelNode,
    depGraph: ReturnType<typeof buildModelGraph>,
): LineageGraph => {
    const modelFamilyIds = [
        ...depGraph.dependantsOf(model.unique_id),
        ...depGraph.dependenciesOf(model.unique_id),
        model.unique_id,
    ];
    return modelFamilyIds.reduce<LineageGraph>(
        (prev, nodeId) => ({
            ...prev,
            [depGraph.getNodeData(nodeId).name]: depGraph
                .directDependenciesOf(nodeId)
                .map((d) => depGraph.getNodeData(d)),
        }),
        {},
    );
};

const convertDbtMetricToLightdashMetric = (
    metric: DbtMetric,
    tableLabel: string,
): Metric => {
    let type: MetricType;
    try {
        type = parseMetricType(metric.type);
    } catch (e) {
        throw new ParseError(
            `Cannot parse metric '${metric.unique_id}: type ${metric.type} is not a valid Lightdash metric type`,
        );
    }
    const table = metric.refs?.[0]?.[0];
    if (!table) {
        throw new ParseError(
            `Cannot determine model from dbt metric "${metric.name}" metric.model is "${metric.model}" but should be "ref('my_model')"`,
        );
    }
    let sql = defaultSql(metric.name);
    if (metric.sql) {
        const isSingleColumnName = /^[a-zA-Z0-9_]+$/g.test(metric.sql);
        if (isSingleColumnName) {
            sql = defaultSql(metric.sql);
        } else {
            sql = metric.sql;
        }
    }
    return {
        fieldType: FieldType.METRIC,
        type,
        isAutoGenerated: false,
        name: metric.name,
        label: metric.label || friendlyName(metric.name),
        table,
        tableLabel,
        sql,
        description: metric.description,
        source: undefined,
        hidden: !!metric.meta?.hidden,
        round: metric.meta?.round,
        format: metric.meta?.format,
        groupLabel: metric.meta?.group_label,
    };
};

export const convertTable = (
    adapterType: SupportedDbtAdapter,
    model: DbtModelNode,
    dbtMetrics: DbtMetric[],
): Omit<Table, 'lineageGraph'> => {
    const meta = model.config?.meta || model.meta; // Config block takes priority, then meta block
    const tableLabel = meta.label || friendlyName(model.name);
    const [dimensions, metrics]: [
        Record<string, Dimension>,
        Record<string, Metric>,
    ] = Object.values(model.columns).reduce(
        ([prevDimensions, prevMetrics], column) => {
            const columnMetrics = Object.fromEntries(
                Object.entries(column.meta.metrics || {}).map(
                    ([name, metric]) => [
                        name,
                        convertMetric({
                            modelName: model.name,
                            columnName: column.name,
                            name,
                            metric,
                            tableLabel,
                        }),
                    ],
                ),
            );

            const dimension = convertDimension(
                adapterType,
                model,
                tableLabel,
                column,
            );

            let extraDimensions = {};

            if (
                [DimensionType.DATE, DimensionType.TIMESTAMP].includes(
                    dimension.type,
                ) &&
                ((column.meta.dimension?.time_intervals &&
                    column.meta.dimension.time_intervals !== 'OFF') ||
                    !column.meta.dimension?.time_intervals)
            ) {
                let intervals: string[] = [];
                if (
                    column.meta.dimension?.time_intervals &&
                    Array.isArray(column.meta.dimension.time_intervals)
                ) {
                    intervals = column.meta.dimension.time_intervals;
                } else {
                    if (dimension.type === DimensionType.TIMESTAMP) {
                        intervals = ['RAW'];
                    }
                    intervals = [...intervals, ...dateIntervals];
                }

                extraDimensions = intervals.reduce(
                    (acc, interval) => ({
                        ...acc,
                        [`${column.name}_${interval}`]: convertDimension(
                            adapterType,
                            model,
                            tableLabel,
                            column,
                            undefined,
                            interval,
                        ),
                    }),
                    {},
                );
            }

            return [
                {
                    ...prevDimensions,
                    [column.name]: dimension,
                    ...extraDimensions,
                },
                { ...prevMetrics, ...columnMetrics },
            ];
        },
        [{}, {}],
    );

    const convertedDbtMetrics = Object.fromEntries(
        dbtMetrics.map((metric) => [
            metric.name,
            convertDbtMetricToLightdashMetric(metric, tableLabel),
        ]),
    );
    const allMetrics = { ...convertedDbtMetrics, ...metrics }; // Model-level metric names take priority

    const duplicatedNames = Object.keys(allMetrics).filter((metric) =>
        Object.keys(dimensions).includes(metric),
    );
    if (duplicatedNames.length > 0) {
        const message =
            duplicatedNames.length > 1
                ? 'Found multiple metrics and a dimensions with the same name:'
                : 'Found a metric and a dimension with the same name:';
        throw new ParseError(`${message} ${duplicatedNames}`);
    }

    return {
        name: model.name,
        label: tableLabel,
        database: model.database,
        schema: model.schema,
        sqlTable: model.relation_name,
        description: model.description || `${model.name} table`,
        dimensions,
        metrics: allMetrics,
    };
};

const translateDbtModelsToTableLineage = (
    models: DbtModelNode[],
): Record<string, Pick<Table, 'lineageGraph'>> => {
    const graph = buildModelGraph(models);
    return models.reduce<Record<string, Pick<Table, 'lineageGraph'>>>(
        (previousValue, currentValue) => ({
            ...previousValue,
            [currentValue.name]: {
                lineageGraph: generateTableLineage(currentValue, graph),
            },
        }),
        {},
    );
};

export const convertExplores = async (
    models: DbtModelNode[],
    loadSources: boolean,
    adapterType: SupportedDbtAdapter,
    metrics: DbtMetric[],
): Promise<(Explore | ExploreError)[]> => {
    const tableLineage = translateDbtModelsToTableLineage(models);
    const [tables, exploreErrors] = models.reduce(
        ([accTables, accErrors], model) => {
            const meta = model.config?.meta || model.meta; // Config block takes priority, then meta block
            // If there are any errors compiling the table return an ExploreError
            try {
                // base dimensions and metrics
                const tableMetrics = metrics.filter((metric) => {
                    const modelRef = metric.refs?.[0]?.[0];
                    return modelRef === model.name;
                });
                const table = convertTable(adapterType, model, tableMetrics);

                // add sources
                if (loadSources && model.patch_path !== null) {
                    throw new Error('Not Implemented');
                }

                // add lineage
                const tableWithLineage: Table = {
                    ...table,
                    ...tableLineage[model.name],
                };

                return [[...accTables, tableWithLineage], accErrors];
            } catch (e) {
                const exploreError: ExploreError = {
                    name: model.name,
                    label: meta.label || friendlyName(model.name),
                    tags: model.tags,
                    errors: [
                        {
                            type: e.name,
                            message:
                                e.message ||
                                `Could not convert dbt model: "${model.name}" in to a Lightdash explore`,
                        },
                    ],
                };
                return [accTables, [...accErrors, exploreError]];
            }
        },
        [[], []] as [Table[], ExploreError[]],
    );
    const tableLookup: Record<string, Table> = tables.reduce(
        (prev, table) => ({ ...prev, [table.name]: table }),
        {},
    );
    const validModels = models.filter(
        (model) => tableLookup[model.name] !== undefined,
    );
    const explores: (Explore | ExploreError)[] = validModels.map((model) => {
        const meta = model.config?.meta || model.meta; // Config block takes priority, then meta block
        try {
            return compileExplore({
                name: model.name,
                label: meta.label || friendlyName(model.name),
                tags: model.tags,
                baseTable: model.name,
                joinedTables: (meta?.joins || []).map((join) => ({
                    table: join.join,
                    sqlOn: join.sql_on,
                })),
                tables: tableLookup,
                targetDatabase: adapterType,
            });
        } catch (e) {
            return {
                name: model.name,
                label: meta.label || friendlyName(model.name),
                errors: [{ type: e.name, message: e.message }],
            };
        }
    });

    return [...explores, ...exploreErrors];
};

export const attachTypesToModels = (
    models: DbtModelNode[],
    warehouseCatalog: {
        [database: string]: {
            [schema: string]: {
                [table: string]: { [column: string]: DimensionType };
            };
        };
    },
    throwOnMissingCatalogEntry: boolean = true,
    caseSensitiveMatching: boolean = true,
): DbtModelNode[] => {
    // Check that all models appear in the warehouse
    models.forEach(({ database, schema, name }) => {
        const databaseMatch = Object.keys(warehouseCatalog).find((db) =>
            caseSensitiveMatching
                ? db === database
                : db.toLowerCase() === database.toLowerCase(),
        );
        const schemaMatch =
            databaseMatch &&
            Object.keys(warehouseCatalog[databaseMatch]).find((s) =>
                caseSensitiveMatching
                    ? s === schema
                    : s.toLowerCase() === schema.toLowerCase(),
            );
        const tableMatch =
            databaseMatch &&
            schemaMatch &&
            Object.keys(warehouseCatalog[databaseMatch][schemaMatch]).find(
                (t) =>
                    caseSensitiveMatching
                        ? t === name
                        : t.toLowerCase() === name.toLowerCase(),
            );
        if (!tableMatch && throwOnMissingCatalogEntry) {
            throw new MissingCatalogEntryError(
                `Model "${name}" was expected in your target warehouse at "${database}.${schema}.${name}". Does the table exist in your target data warehouse?`,
                {},
            );
        }
    });

    const getType = (
        { database, schema, name }: DbtModelNode,
        columnName: string,
    ): DimensionType | undefined => {
        const databaseMatch = Object.keys(warehouseCatalog).find((db) =>
            caseSensitiveMatching
                ? db === database
                : db.toLowerCase() === database.toLowerCase(),
        );
        const schemaMatch =
            databaseMatch &&
            Object.keys(warehouseCatalog[databaseMatch]).find((s) =>
                caseSensitiveMatching
                    ? s === schema
                    : s.toLowerCase() === schema.toLowerCase(),
            );
        const tableMatch =
            databaseMatch &&
            schemaMatch &&
            Object.keys(warehouseCatalog[databaseMatch][schemaMatch]).find(
                (t) =>
                    caseSensitiveMatching
                        ? t === name
                        : t.toLowerCase() === name.toLowerCase(),
            );
        const columnMatch =
            databaseMatch &&
            schemaMatch &&
            tableMatch &&
            Object.keys(
                warehouseCatalog[databaseMatch][schemaMatch][tableMatch],
            ).find((c) =>
                caseSensitiveMatching
                    ? c === columnName
                    : c.toLowerCase() === columnName.toLowerCase(),
            );
        if (databaseMatch && schemaMatch && tableMatch && columnMatch) {
            return warehouseCatalog[databaseMatch][schemaMatch][tableMatch][
                columnMatch
            ];
        }
        if (throwOnMissingCatalogEntry) {
            throw new MissingCatalogEntryError(
                `Column "${columnName}" from model "${name}" does not exist.\n "${name}.${columnName}" was not found in your target warehouse at ${database}.${schema}.${name}. Try rerunning dbt to update your warehouse.`,
                {},
            );
        }
        return undefined;
    };

    // Update the dbt models with type info
    return models.map((model) => ({
        ...model,
        columns: Object.fromEntries(
            Object.entries(model.columns).map(([column_name, column]) => [
                column_name,
                { ...column, data_type: getType(model, column_name) },
            ]),
        ),
    }));
};

export const getSchemaStructureFromDbtModels = (
    dbtModels: DbtModelNode[],
): { database: string; schema: string; table: string }[] =>
    dbtModels.map(({ database, schema, name }) => ({
        database,
        schema,
        table: name,
    }));
