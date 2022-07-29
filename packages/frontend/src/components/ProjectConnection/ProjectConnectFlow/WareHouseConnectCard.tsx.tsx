import { WarehouseTypes } from '@lightdash/common';
import React, { FC, useMemo, useState } from 'react';
import BigQuery from './Assets/bigquery.svg';
import Databricks from './Assets/databricks.svg';
import PostgressLogo from './Assets/postgresql.svg';
import Redshift from './Assets/redshift.svg';
import Snowflake from './Assets/snowflake.svg';
import InviteExpertFooter from './InviteExpertFooter';
import {
    ConnectWarehouseWrapper,
    ExternalLink,
    Subtitle,
    Title,
    WarehouseButton,
    WarehouseGrid,
    WarehouseIcon,
    Wrapper,
} from './ProjectConnectFlow.styles';

export type SelectedWarehouse = {
    label: string;
    key: WarehouseTypes;
    icon: string;
};
interface Props {
    setWarehouse: (warehouse: SelectedWarehouse) => void;
    showDemoLink?: boolean;
}

export const WarehouseTypeLabels = [
    {
        label: 'BigQuery',
        key: WarehouseTypes.BIGQUERY,
        icon: BigQuery,
    },
    {
        label: 'Databricks',
        key: WarehouseTypes.DATABRICKS,
        icon: Databricks,
    },
    {
        label: 'PostgreSQL',
        key: WarehouseTypes.POSTGRES,
        icon: PostgressLogo,
    },
    {
        label: 'Redshift',
        key: WarehouseTypes.REDSHIFT,
        icon: Redshift,
    },
    {
        label: 'Snowflake',
        key: WarehouseTypes.SNOWFLAKE,
        icon: Snowflake,
    },
    {
        label: 'Mysql',
        key: WarehouseTypes.MYSQL,
        icon: Snowflake,
    }
];

const WareHouseConnectCard: FC<Props> = ({ setWarehouse, showDemoLink }) => {
    const [warehouseInfo, setWarehouseInfo] = useState<
        SelectedWarehouse[] | undefined
    >();

    useMemo(() => {
        setWarehouseInfo(WarehouseTypeLabels);
    }, []);

    return (
        <Wrapper>
            <ConnectWarehouseWrapper>
                <Title>Connect your project</Title>
                <Subtitle>Select your warehouse:</Subtitle>
                <WarehouseGrid>
                    {warehouseInfo?.map((item) => (
                        <WarehouseButton
                            key={item.key}
                            outlined
                            icon={
                                <WarehouseIcon src={item.icon} alt={item.key} />
                            }
                            onClick={() => setWarehouse(item)}
                        >
                            {item.label}
                        </WarehouseButton>
                    ))}
                </WarehouseGrid>
                {showDemoLink && (
                    <ExternalLink
                        href="https://demo.lightdash.com/"
                        target="_blank"
                    >
                        ...or try our demo project instead
                    </ExternalLink>
                )}
            </ConnectWarehouseWrapper>
            {showDemoLink && <InviteExpertFooter />}
        </Wrapper>
    );
};
export default WareHouseConnectCard;
