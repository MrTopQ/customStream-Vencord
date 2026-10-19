/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { ImageIcon } from "@components/Icons";
import definePlugin from "@utils/types";
import { closeModal, Menu, openModal, UserStore } from "@webpack/common";

import { GalleryModal } from "./components/GalleryModal";
import { StreamPreviewPanelButton } from "./components/PanelButton";
import { captureFrame, FrameSource, PLACEHOLDER_FRAME, VideoFrame } from "./frames";
import { registerHotkey, unregisterHotkey } from "./hotkey";
import { T } from "./i18n";
import { getActiveProfile, getProfiles, loadLibrary, unloadLibrary } from "./library";
import { forgetAllThumbs } from "./media";
import {
    ensureCustomThumbnail,
    isOwnStreamEvent,
    onUploaderStarted,
    onUploaderStopped,
    onUploadFailed,
    onVideoStateChanged,
    pickThumbnail,
    startOnAir,
    stopOnAir,
    willSendCustom
} from "./onAir";
import { DEFAULT_HOTKEY, PLUGIN_NAME, settings, unwatchSettings, watchSettings } from "./settings";
import managedStyle from "./style.css?managed";
import { logger } from "./utils";

const GALLERY_MODAL_KEY = "custom-stream-topq-gallery";
let galleryOpen = false;

function openGallery() {
    if (galleryOpen) return;
    galleryOpen = true;
    openModal(props => <GalleryModal rootProps={props} />, {
        modalKey: GALLERY_MODAL_KEY,
        onCloseCallback: () => { galleryOpen = false; }
    });
}

function toggleGallery() {
    if (!galleryOpen) {
        openGallery();
        return;
    }
    closeModal(GALLERY_MODAL_KEY);
    galleryOpen = false;
}

const streamContextMenuPatch: NavContextMenuPatchCallback = (children, { stream }: { stream?: { ownerId: string; }; }) => {
    if (!stream || stream.ownerId !== UserStore.getCurrentUser()?.id) return;

    const item = (
        <Menu.MenuItem
            id="custom-stream-preview"
            label={T.contextMenuItem}
            icon={ImageIcon}
            action={openGallery}
        />
    );

    const group = findGroupChildrenByChildId(["fullscreen", "popout"], children);
    if (group) group.push(item);
    else children.push(<Menu.MenuSeparator />, item);
};

function nextPreviewFrame(source: FrameSource, streamId: string): Promise<VideoFrame> {
    return willSendCustom() ? Promise.resolve(PLACEHOLDER_FRAME) : captureFrame(source, streamId);
}

const PanelButton = ErrorBoundary.wrap(
    (props: { nameplate?: unknown; }) => <StreamPreviewPanelButton nameplate={props?.nameplate} onOpen={openGallery} />,
    { noop: true }
);

export default definePlugin({
    name: PLUGIN_NAME,
    get description() {
        return T.pluginDescription;
    },
    authors: [{ name: "TopQ", id: 523800559791374356n }],
    settings,
    managedStyle,

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /(children:\[)(.{0,150}?)(accountContainerRef)/,
                replace: "$1$self.PanelButton(arguments[0]),$2$3"
            }
        },
        {
            find: '"ApplicationStreamPreviewUploadManager"',
            replacement: [
                {
                    match: /(\i)\.getNextVideoOutputFrame\((\i)\)\.then\(/,
                    replace: "$self.nextPreviewFrame($1,$2).then("
                },
                {
                    match: /if\(!(\i)\)try\{(?=.{0,300}?nextPreviewFrame)/,
                    replace: "if(!$1||$self.willSendCustom())try{"
                },
                {
                    match: /(\i)\?(\i)\.start\(6e4,(\i)\):\2\.start\(3e5,\3\)/,
                    replace: "$1&&!$self.willSendCustom()?$2.start(6e4,$3):$2.start(3e5,$3)"
                },
                {
                    match: /subscribe\("STREAM_DELETE",(\i)\)/,
                    replace: 'subscribe("STREAM_DELETE",e=>$self.isOwnStreamEvent(e)&&$1())'
                },
                {
                    match: /(\i)\.toDataURL\("image\/jpeg"\)/,
                    replace: '$self.pickThumbnail(()=>$1.toDataURL("image/jpeg"))'
                },
                {
                    match: /\{thumbnail:(\i)\}/g,
                    replace: "{thumbnail:$self.ensureCustomThumbnail($1)}"
                },
                {
                    match: /"Failed to post stream preview",\i\)/,
                    replace: "$&,$self.onUploadFailed()"
                }
            ]
        }
    ],

    flux: {
        RTC_CONNECTION_VIDEO({ userId, streamId, context }: { userId: string; streamId?: string | null; context?: string; }) {
            if (context === "stream" && streamId != null && userId === UserStore.getCurrentUser()?.id) onUploaderStarted();
        },
        STREAM_DELETE(event: { streamKey?: string; }) {
            if (isOwnStreamEvent(event)) onUploaderStopped();
        },
        CONNECTION_OPEN: onUploaderStopped,
        LOGOUT: onUploaderStopped,
        MEDIA_ENGINE_VIDEO_STATE_CHANGED({ videoState }: { videoState?: string; }) {
            onVideoStateChanged(videoState === "paused");
        }
    },

    contextMenus: {
        "stream-context": streamContextMenuPatch
    },

    toolboxActions() {
        return <Menu.MenuItem id="custom-stream-gallery" label={T.toolboxOpen} action={openGallery} />;
    },

    PanelButton,
    pickThumbnail,
    ensureCustomThumbnail,
    onUploadFailed,
    willSendCustom,
    isOwnStreamEvent,
    nextPreviewFrame,

    async start() {
        registerHotkey(() => settings.store.hotkey || DEFAULT_HOTKEY, toggleGallery);
        watchSettings();

        await loadLibrary();
        await startOnAir();

        const active = getActiveProfile();
        logger.info(`Loaded ${getProfiles().length} profiles, "${active.name}" is active with ${active.images.length} images`);
    },

    stop() {
        unregisterHotkey();
        unwatchSettings();
        stopOnAir();
        unloadLibrary();
        forgetAllThumbs();
        closeModal(GALLERY_MODAL_KEY);
        galleryOpen = false;
    }
});
