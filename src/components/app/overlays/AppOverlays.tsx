import React, { useEffect } from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import SearchWorkspace from '../search/SearchWorkspace';
import DevDebugOverlay from '../../DevDebugOverlay';
import MemoryMonitorWindow from '../../debug/MemoryMonitorWindow';
import NowPlayingToast from './NowPlayingToast';
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    // 当前视图写进 <html>，手机壳的样式据此隐藏只属于资料库的常驻控件（播放页不显示墙面工具）。
    const currentView = model.floatingControls?.currentView ?? 'home';
    useEffect(() => {
        if (typeof document === 'undefined') return;
        document.documentElement.dataset.foliaView = currentView;
    }, [currentView]);
    const {
        searchOverlay,
        debugOverlay,
        memoryMonitor,
        floatingControls,
        nowPlayingToast,
    } = model;

    return (
        <>
            {searchOverlay && <SearchWorkspace {...searchOverlay} />}

            {debugOverlay && <DevDebugOverlay {...debugOverlay} />}

            {memoryMonitor && <MemoryMonitorWindow {...memoryMonitor} />}

            {/* 播放条只在播放页出现：资料库与拼贴页自己就有控制，浮层会压住它们的按钮。 */}
            {floatingControls
                && floatingControls.currentView === 'player'
                && <FloatingPlayerControls {...floatingControls} />}

            {nowPlayingToast && <NowPlayingToast {...nowPlayingToast} />}
        </>
    );
};

export default React.memo(AppOverlays);
