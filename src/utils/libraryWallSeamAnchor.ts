// src/utils/libraryWallSeamAnchor.ts
// Where the 书库 seam sits. `world` is the original behaviour: the seam belongs to the wall, so it
// opens on a block boundary near the camera and rides along as the wall pans. The four edge values
// pin it to that screen edge instead, and the wall pans behind it without opening a split.

export type LibraryWallSeamAnchor = 'world' | 'left' | 'right' | 'top' | 'bottom';

export const LIBRARY_WALL_SEAM_ANCHORS: readonly LibraryWallSeamAnchor[] = Object.freeze([
    'world', 'left', 'right', 'top', 'bottom',
] as const);

export const DEFAULT_LIBRARY_WALL_SEAM_ANCHOR: LibraryWallSeamAnchor = 'world';

const LABEL_KEYS: Readonly<Record<LibraryWallSeamAnchor, string>> = Object.freeze({
    world: 'options.bravaisSeamAnchorWorld',
    left: 'options.bravaisSeamAnchorLeft',
    right: 'options.bravaisSeamAnchorRight',
    top: 'options.bravaisSeamAnchorTop',
    bottom: 'options.bravaisSeamAnchorBottom',
});

export const libraryWallSeamAnchorLabelKey = (anchor: LibraryWallSeamAnchor): string => LABEL_KEYS[anchor];

export const isLibraryWallSeamAnchor = (value: unknown): value is LibraryWallSeamAnchor => (
    typeof value === 'string' && (LIBRARY_WALL_SEAM_ANCHORS as readonly string[]).includes(value)
);

export const normalizeLibraryWallSeamAnchor = (value: unknown): LibraryWallSeamAnchor => (
    isLibraryWallSeamAnchor(value) ? value : DEFAULT_LIBRARY_WALL_SEAM_ANCHOR
);

/** True for the four pinned edges; false for the wall-anchored default. */
export const isPinnedSeamAnchor = (anchor: LibraryWallSeamAnchor): boolean => anchor !== 'world';

/** The two anchors whose seam is a horizontal bar rather than a vertical strip. */
export const isHorizontalSeamAnchor = (anchor: LibraryWallSeamAnchor): boolean => (
    anchor === 'top' || anchor === 'bottom'
);

/** Height of the horizontal bar, and the vertical strip's width (the bottom tool column's). */
export const PINNED_SEAM_BAR_PX = 72;
export const PINNED_SEAM_STRIP_PX = 152;
/** 缩小后的图标列宽度。 */
export const PINNED_SEAM_RAIL_PX = 64;
