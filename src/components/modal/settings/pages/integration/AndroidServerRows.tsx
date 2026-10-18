import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Row, Status } from '../../kit';
import { O } from './options';
import { callNative } from '../../../../../services/mobileShell/nativeBridge';
import {
    discoverServers,
    getDiscoveryState,
    onDiscoveryStateChange,
    type DiscoveryState,
} from '../../../../../services/mobileShell/serverDiscovery';

// src/components/modal/settings/pages/integration/AndroidServerRows.tsx
// Android only: the online backends are separate deployments. The shell finds them on the network by
// itself, so this row reports what it found and offers a re-probe; the addresses themselves live in
// native settings because they have to exist before the web app boots.

const foundCount = (state: DiscoveryState): number => (
    [state.servers.netease, state.servers.kugou, state.servers.qq].filter(Boolean).length
);

const AndroidServerRows: React.FC = () => {
    const { t } = useTranslation();
    const [state, setState] = useState<DiscoveryState>(getDiscoveryState());

    useEffect(() => onDiscoveryStateChange(setState), []);

    const count = foundCount(state);
    const summary = state.status === 'probing'
        ? t('options.androidServersProbing')
        : count > 0
            ? t('options.androidServersFound', { count })
            : t('options.androidServersNone');

    return (
        <Row option={O.androidServers} hint={t('options.androidServersDesc')}>
            <Status tone={count > 0 ? 'ok' : undefined}>{summary}</Status>
            <Button onClick={() => void discoverServers({ force: true })} disabled={state.status === 'probing'}>
                {t('options.androidServersRedetect')}
            </Button>
            <Button
                onClick={() => {
                    void callNative('servers.openSettings', {}, 15_000).catch(error => {
                        console.error('[Settings] Could not open the native server settings', error);
                    });
                }}
            >
                {t('options.androidServersEdit')}
            </Button>
        </Row>
    );
};

export default AndroidServerRows;
