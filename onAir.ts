/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserStore } from "@webpack/common";

import { getActiveProfile, libraryChanged, Profile, setCurrentIndex, StoredImage } from "./library";
import { blobToDataUrl } from "./media";
import { IDLE_UPLOADER, nextIndex, shuffledIds, UploaderState } from "./schedule";
import { settings, settingsChanged } from "./settings";
import { createEmitter, logger } from "./utils";

const DATA_URI_CACHE_SIZE = 3;

export const airChanged = createEmitter();

let uploader: UploaderState = IDLE_UPLOADER;
let sentImage: StoredImage | null = null;
let hold = true;
let bag: { profileId: string; ids: string[]; } = { profileId: "", ids: [] };
let lastReturned: string | null = null;
const dataUris = new Map<string, string>();

export function getUploader(): UploaderState {
    return uploader;
}

export function getSentImage(): StoredImage | null {
    return sentImage;
}

function setUploader(next: UploaderState) {
    uploader = next;
    airChanged.emit();
}

export function onUploaderStarted() {
    sentImage = null;
    hold = true;
    setUploader({ ...IDLE_UPLOADER, running: true, runningSince: Date.now(), paused: uploader.paused });
    schedulePrepare();
}

export function onUploaderStopped() {
    if (!uploader.running && uploader.sentAt === 0) return;
    sentImage = null;
    setUploader({ ...IDLE_UPLOADER, paused: uploader.paused });
}

export function onVideoStateChanged(paused: boolean) {
    if (uploader.paused !== paused) setUploader({ ...uploader, paused });
}

export function onUploadFailed() {
    setUploader({ ...uploader, running: true, failedAt: Date.now() });
}

export function isOwnStreamEvent(event: { streamKey?: string; } | undefined): boolean {
    const ownerId = event?.streamKey?.split(":").at(-1);
    return ownerId != null && ownerId === UserStore.getCurrentUser()?.id;
}

export function willSendCustom(): boolean {
    if (!settings.store.replaceEnabled) return false;
    return getActiveProfile().images.some(image => dataUris.has(image.id));
}

function peekShuffled(profile: Profile): string | null {
    const liveIds = new Set(profile.images.map(image => image.id));
    let ids = bag.profileId === profile.id ? bag.ids.filter(id => liveIds.has(id)) : [];

    if (ids.length === 0) {
        const currentId = profile.images[profile.currentIndex]?.id ?? null;
        ids = shuffledIds([...liveIds], currentId);
    }

    bag = { profileId: profile.id, ids };
    return ids[0] ?? null;
}

export function isHolding(): boolean {
    return hold;
}

export function getUpcomingIndex(profile: Profile = getActiveProfile()): number {
    return nextIndex(
        profile.images.length,
        profile.currentIndex,
        { slideshow: settings.store.slideshowEnabled, random: settings.store.slideshowRandom, hold },
        () => {
            const id = peekShuffled(profile);
            return id ? profile.images.findIndex(image => image.id === id) : -1;
        }
    );
}

export function chooseImage(index: number) {
    const profile = getActiveProfile();
    if (index < 0 || index >= profile.images.length) return;

    hold = true;
    void setCurrentIndex(profile.id, index);
    airChanged.emit();
    schedulePrepare();
}

export function holdCurrent() {
    if (hold) return;
    hold = true;
    airChanged.emit();
    schedulePrepare();
}

function rememberDataUri(id: string, uri: string) {
    dataUris.delete(id);
    dataUris.set(id, uri);
    while (dataUris.size > DATA_URI_CACHE_SIZE) {
        const oldest = dataUris.keys().next().value;
        if (oldest === undefined) break;
        dataUris.delete(oldest);
    }
}

export async function prepareUpcoming(): Promise<void> {
    if (!settings.store.replaceEnabled) return;

    const profile = getActiveProfile();
    const image = profile.images[getUpcomingIndex(profile)];
    if (!image || dataUris.has(image.id)) return;

    try {
        rememberDataUri(image.id, await blobToDataUrl(image.blob));
    } catch (error) {
        logger.error("Could not prepare the next preview image", error);
    }
}

let prepareQueued = false;

function schedulePrepare() {
    if (prepareQueued) return;
    prepareQueued = true;
    queueMicrotask(() => {
        prepareQueued = false;
        void prepareUpcoming();
    });
}

function recordSent(image: StoredImage | null, at: number) {
    sentImage = image;
    setUploader({
        ...uploader,
        running: true,
        runningSince: uploader.running ? uploader.runningSince : at,
        sentAt: at,
        sentImageId: image?.id ?? null,
        failedAt: 0
    });
}

export function pickThumbnail(makeOriginal: () => string): string {
    const now = Date.now();
    const profile = getActiveProfile();
    const upcoming = settings.store.replaceEnabled ? profile.images[getUpcomingIndex(profile)] : undefined;

    let chosen = upcoming && dataUris.has(upcoming.id) ? upcoming : undefined;
    if (upcoming && !chosen) {
        chosen = profile.images.find(image => dataUris.has(image.id));
        logger.warn("The next image was not ready yet, sending a prepared one instead");
    }

    if (!chosen) {
        const original = makeOriginal();
        recordSent(null, now);
        lastReturned = original;
        return original;
    }

    const chosenId = chosen.id;
    if (bag.profileId === profile.id) bag = { ...bag, ids: bag.ids.filter(id => id !== chosenId) };
    hold = false;

    void setCurrentIndex(profile.id, profile.images.indexOf(chosen));
    recordSent(chosen, now);
    schedulePrepare();

    const uri = dataUris.get(chosenId)!;
    lastReturned = uri;
    return uri;
}

export function ensureCustomThumbnail(value: string): string {
    return value === lastReturned ? value : pickThumbnail(() => value);
}

let unsubscribers: (() => void)[] = [];
let activeProfileId: string | null = null;

function onLibraryChanged() {
    const { id } = getActiveProfile();
    if (id !== activeProfileId) {
        activeProfileId = id;
        hold = true;
    }
    schedulePrepare();
}

export function startOnAir() {
    activeProfileId = getActiveProfile().id;
    unsubscribers = [
        libraryChanged.subscribe(onLibraryChanged),
        settingsChanged.subscribe(() => {
            schedulePrepare();
            airChanged.emit();
        })
    ];
    return prepareUpcoming();
}

export function stopOnAir() {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    unsubscribers = [];
    uploader = IDLE_UPLOADER;
    sentImage = null;
    hold = true;
    bag = { profileId: "", ids: [] };
    lastReturned = null;
    activeProfileId = null;
    dataUris.clear();
}
