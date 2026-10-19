/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderModalProps } from "@vencord/discord-types";
import { Modal, showToast, useEffect, useRef, useState } from "@webpack/common";
import type { DragEvent } from "react";

import { T } from "../i18n";
import { addImages, getActiveProfile, isStorageReady, libraryChanged, MAX_IMAGES_PER_PROFILE } from "../library";
import { ACCEPTED_TYPES, isAcceptedFile, toPreviewImage } from "../media";
import { settings } from "../settings";
import { cl, logger, useEmitter } from "../utils";
import { AirCard } from "./AirCard";
import { Library } from "./Library";
import { Lightbox } from "./Lightbox";
import { PlaybackControls } from "./PlaybackControls";
import { ProfileTabs } from "./ProfileTabs";

function hasFiles(event: DragEvent) {
    return event.dataTransfer.types.includes("Files");
}

function isTyping(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    return element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.isContentEditable === true;
}

export function GalleryModal({ rootProps }: { rootProps: RenderModalProps; }) {
    useEmitter(libraryChanged);
    const { hotkey } = settings.use(["hotkey", "language"]);
    const profile = getActiveProfile();

    const [busy, setBusy] = useState(false);
    const [viewing, setViewing] = useState<number | null>(null);
    const [dropDepth, setDropDepth] = useState(0);
    const busyRef = useRef(false);

    const importFiles = async (files: File[]) => {
        if (busyRef.current || files.length === 0) return;

        const target = getActiveProfile();
        const room = MAX_IMAGES_PER_PROFILE - target.images.length;
        if (room <= 0) {
            showToast({ text: T.profileFull(target.name, MAX_IMAGES_PER_PROFILE), variant: "critical" });
            return;
        }

        const accepted = files.filter(isAcceptedFile);
        const skipped = files.length - accepted.length;
        if (accepted.length === 0) {
            showToast({ text: T.onlyImages, variant: "critical" });
            return;
        }

        busyRef.current = true;
        setBusy(true);
        try {
            const blobs: Blob[] = [];
            for (const file of accepted.slice(0, room)) {
                blobs.push(await toPreviewImage(file));
            }

            const added = await addImages(target.id, blobs);
            const left = accepted.length - added;
            showToast({ text: T.added(added, skipped, Math.max(0, left)), variant: "success" });
        } catch (error) {
            logger.error("Import failed", error);
            showToast({ text: T.readFailed, variant: "critical" });
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    const importRef = useRef(importFiles);
    importRef.current = importFiles;

    const pickFiles = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ACCEPTED_TYPES.join(",");
        input.multiple = true;
        input.onchange = () => {
            if (input.files?.length) void importRef.current([...input.files]);
        };
        input.click();
    };

    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            if (isTyping(event.target)) return;

            const files = [...event.clipboardData?.items ?? []]
                .filter(item => item.kind === "file")
                .map(item => item.getAsFile())
                .filter((file): file is File => file != null);

            if (files.length === 0) return;
            event.preventDefault();
            void importRef.current(files);
        };

        document.addEventListener("paste", onPaste);
        return () => document.removeEventListener("paste", onPaste);
    }, []);

    const dropHandlers = {
        onDragEnter(event: DragEvent) {
            if (hasFiles(event)) setDropDepth(depth => depth + 1);
        },
        onDragLeave(event: DragEvent) {
            if (hasFiles(event)) setDropDepth(depth => Math.max(0, depth - 1));
        },
        onDragOver(event: DragEvent) {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        },
        onDrop(event: DragEvent) {
            if (!hasFiles(event)) return;
            event.preventDefault();
            setDropDepth(0);
            void importFiles([...event.dataTransfer.files]);
        }
    };

    return (
        <Modal
            {...rootProps}
            size="xl"
            title={T.modalTitle}
            subtitle={T.modalSubtitle}
            actionBarInput={
                <span className={cl("footnote")}>
                    {isStorageReady() ? T.storedLocally : T.storageFailed}
                    {hotkey && ` ${T.hotkeyOpens(hotkey)}`}
                </span>
            }
            actions={[{ text: T.done, variant: "primary", onClick: rootProps.onClose }]}
        >
            <div className={cl("root")} {...dropHandlers}>
                <AirCard />
                <PlaybackControls />
                <ProfileTabs />
                <Library key={profile.id} profile={profile} busy={busy} onAdd={pickFiles} onView={setViewing} />

                {dropDepth > 0 && (
                    <div className={cl("dropzone")}>
                        <span>{T.dropToAdd(profile.name)}</span>
                    </div>
                )}
            </div>

            {viewing !== null && (
                <Lightbox images={profile.images} index={viewing} onChange={setViewing} onClose={() => setViewing(null)} />
            )}
        </Modal>
    );
}
