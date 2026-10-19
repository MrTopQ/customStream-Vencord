/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationStreamingStore, useEffect, useState, useStateFromStores } from "@webpack/common";

import { T } from "../i18n";
import { findImage, getActiveProfile, libraryChanged, StoredImage } from "../library";
import { loadThumb, peekThumb } from "../media";
import { airChanged, getSentImage, getUpcomingIndex, getUploader } from "../onAir";
import { UploaderState } from "../schedule";
import { settings } from "../settings";
import { cl, logger, useEmitter } from "../utils";

export function Thumb({ image, className }: { image: StoredImage; className?: string; }) {
    const [url, setUrl] = useState(() => peekThumb(image.id));

    useEffect(() => {
        const ready = peekThumb(image.id);
        setUrl(ready);
        if (ready) return;

        let alive = true;
        loadThumb(image.id, image.blob).then(
            next => alive && setUrl(next),
            error => logger.error("Could not render a thumbnail", error)
        );
        return () => { alive = false; };
    }, [image.id]);

    return url
        ? <img src={url} className={cl("thumb", className)} alt="" draggable={false} decoding="async" />
        : <div className={cl("thumb", "thumb-pending", className)} />;
}

export interface AirView {
    live: boolean;
    previewDisabled: boolean;
    replaceEnabled: boolean;
    imageCount: number;
    uploader: UploaderState;
    sentImage: StoredImage | null;
    sentLabel: string | null;
    upcomingImage: StoredImage | null;
    upcomingIndex: number;
    upcomingLabel: string | null;
    shownImage: StoredImage | null;
}

function labelFor(image: StoredImage | null, activeProfileId: string): string | null {
    if (!image) return null;

    const found = findImage(image.id);
    if (!found) return T.deletedImage;
    if (found.profile.id === activeProfileId) return `#${found.index + 1}`;
    return T.imageFromProfile(`#${found.index + 1}`, found.profile.name);
}

export function useAirView(): AirView {
    useEmitter(airChanged);
    useEmitter(libraryChanged);
    const { replaceEnabled } = settings.use(["replaceEnabled", "slideshowEnabled", "slideshowRandom", "language"]);

    const live = useStateFromStores([ApplicationStreamingStore], () => ApplicationStreamingStore.getCurrentUserActiveStream() != null);
    const previewDisabled = useStateFromStores(
        [ApplicationStreamingStore],
        () => ApplicationStreamingStore.getStreamerActiveStreamMetadata()?.previewDisabled === true
    );

    const profile = getActiveProfile();
    const uploader = getUploader();
    const upcomingIndex = getUpcomingIndex(profile);
    const upcomingImage = profile.images[upcomingIndex] ?? null;
    const sentImage = getSentImage();
    const hasSent = live && uploader.sentAt > 0;

    return {
        live,
        previewDisabled,
        replaceEnabled,
        imageCount: profile.images.length,
        uploader,
        sentImage,
        sentLabel: labelFor(sentImage, profile.id),
        upcomingImage,
        upcomingIndex,
        upcomingLabel: upcomingImage ? `#${upcomingIndex + 1}` : null,
        shownImage: hasSent ? sentImage : replaceEnabled ? upcomingImage : null
    };
}
