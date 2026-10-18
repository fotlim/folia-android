import { useCallback, useRef, type RefObject } from 'react';
import { formatWorldTransform, type WallView, type WallViewCenter } from '../../../components/wall/wallView';
import { computeBravaisFrame, posterSafeArea, withTilt } from './bravaisFrame';

// src/library/suites/bravais/useBravaisFrame.ts
// stage 每帧要写的那几样（相机、缝的锚点与动画中的开口、缝内容的排版宽度、是否折叠）放在一个可变的 ref 里，
// 相机与缝的动画只改它再调 renderFrame：直接写两个世界层的 transform、缝的位置与宽度、缝内容的透明度、
// 边缘标签的显隐与侧别，不经过 React（frontend-runtime-guardrails：拖动、补间期间没有逐帧 setState）。

export type BravaisFrameState = {
    view: WallView | null;
    center: WallViewCenter;
    anchorX: number | null;
    openWidth: number;
    /** 开口正在补间去的宽度（不补间时等于 openWidth）：开口张开途中给聚焦卡的相机让位按张开后的缝算。 */
    targetOpenWidth: number;
    contentWidth: number;
    hidden: boolean;
    /** 歌手海报：开口贴着视口边也不收窄（bravaisFrame 的 poster）。 */
    poster: boolean;
    /** 整层此刻的倾斜角（度；补间中逐帧变）。 */
    tiltDeg: number;
};

export type BravaisFrameRefs = {
    left: RefObject<HTMLDivElement | null>;
    right: RefObject<HTMLDivElement | null>;
    seam: RefObject<HTMLDivElement | null>;
    seamContent: RefObject<HTMLDivElement | null>;
    tab: RefObject<HTMLButtonElement | null>;
};

export const useBravaisFrame = (refs: BravaisFrameRefs) => {
    const pinnedRef = useRef(false);

    const stateRef = useRef<BravaisFrameState>({
        view: null,
        center: { x: 0, y: 0 },
        anchorX: null,
        openWidth: 0,
        targetOpenWidth: 0,
        contentWidth: 0,
        hidden: false,
        poster: false,
        tiltDeg: 0,
    });

    const renderFrame = useCallback(() => {
        const state = stateRef.current;
        if (!state.view) return;
        const frame = computeBravaisFrame({
            center: state.center,
            view: state.view,
            anchorX: state.anchorX,
            // A pinned seam is not part of the wall: the split stays shut so the wall pans behind a
            // panel that never moves. The panel's own position is written by the stage.
            openWidth: pinnedRef.current ? 0 : state.openWidth,
            contentWidth: pinnedRef.current ? 0 : state.contentWidth,
            hidden: state.hidden,
            poster: state.poster,
            tiltDeg: state.tiltDeg,
        });
        const { left, right, seam, seamContent, tab } = refs;
        if (left.current) left.current.style.transform = withTilt(formatWorldTransform(frame.left.x, frame.left.y, frame.scale), frame.tilt);
        if (right.current) right.current.style.transform = withTilt(formatWorldTransform(frame.right.x, frame.right.y, frame.scale), frame.tilt);
        const seamElement = seam.current;
        // While pinned the stage owns the seam's box; leaving the world writes in place would drag
        // the panel back to the wall every frame.
        if (seamElement && !pinnedRef.current) {
            // 缝与两半墙同一层：倾斜时一起转（缝的 transform-origin 对准屏幕原点，见 bravais.css / bravaisPoster.css）。
            seamElement.style.transform = withTilt(`translate3d(${frame.seam.x - frame.seam.width / 2}px, 0, 0)`, frame.tilt);
            seamElement.style.width = `${frame.seam.width}px`;
            const visibility = frame.seam.visible ? 'visible' : 'hidden';
            if (seamElement.style.visibility !== visibility) seamElement.style.visibility = visibility;
        }
        const contentElement = seamContent.current;
        if (contentElement) {
            // 贴边时缝不在墙的开口里，帧算出来的 contentOpacity 会是 0；面板要一直看得见。
            contentElement.style.opacity = pinnedRef.current ? '1' : String(frame.contentOpacity);
            // 海报跟着倾斜时四个角会转出屏幕：内容缩进安全区（posterSafeArea，按落定的海报宽度算，拖动时不变）。
            const safe = state.poster
                ? posterSafeArea({ width: state.targetOpenWidth, height: state.view.height, deg: frame.tilt.deg })
                : { scale: 1, offsetY: 0 };
            contentElement.style.setProperty('--bravais-poster-safe-scale', safe.scale.toFixed(4));
            contentElement.style.setProperty('--bravais-poster-safe-y', `${safe.offsetY.toFixed(1)}px`);
        }
        const tabElement = tab.current;
        if (tabElement) {
            const display = frame.tab.visible ? '' : 'none';
            if (tabElement.style.display !== display) tabElement.style.display = display;
            if (tabElement.dataset.side !== frame.tab.side) tabElement.dataset.side = frame.tab.side;
        }
    }, [refs]);

    return { stateRef, renderFrame, pinnedRef };
};
