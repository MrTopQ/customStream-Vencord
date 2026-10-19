/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PencilIcon } from "@components/Icons";
import { Alerts, showToast, useState } from "@webpack/common";

import { T } from "../i18n";
import {
    createProfile,
    DEFAULT_PROFILE_ID,
    deleteProfile,
    getActiveProfile,
    getProfiles,
    libraryChanged,
    MAX_PROFILE_NAME,
    MAX_PROFILES,
    renameProfile,
    setActiveProfile
} from "../library";
import { settings } from "../settings";
import { cl, useEmitter } from "../utils";
import { PlusIcon, TrashIcon } from "./icons";

const NEW_PROFILE = "\0new";

function NameInput({ initial, onDone }: { initial: string; onDone(name: string | null): void; }) {
    const [value, setValue] = useState(initial);
    const finish = (save: boolean) => {
        const name = value.trim();
        onDone(save && name ? name : null);
    };

    return (
        <input
            className={cl("profile-input")}
            value={value}
            maxLength={MAX_PROFILE_NAME}
            placeholder={T.profileNamePlaceholder}
            autoFocus
            onChange={e => setValue(e.currentTarget.value)}
            onBlur={() => finish(true)}
            onKeyDown={e => {
                if (e.key === "Enter") finish(true);
                if (e.key === "Escape") {
                    e.stopPropagation();
                    finish(false);
                }
            }}
        />
    );
}

export function ProfileTabs() {
    useEmitter(libraryChanged);
    settings.use(["language"]);
    const [editing, setEditing] = useState<string | null>(null);

    const profiles = getProfiles();
    const active = getActiveProfile();
    const canDelete = active.id !== DEFAULT_PROFILE_ID && active.images.length === 0;

    const finishEditing = (profileId: string, name: string | null) => {
        setEditing(null);
        if (!name) return;

        if (profileId === NEW_PROFILE) {
            if (!createProfile(name)) showToast({ text: T.profileLimit(MAX_PROFILES), variant: "critical" });
        } else {
            void renameProfile(profileId, name);
        }
    };

    const confirmDelete = () => Alerts.show({
        title: T.deleteProfileTitle(active.name),
        body: T.deleteProfileBody,
        confirmText: T.delete,
        cancelText: T.cancel,
        confirmColor: "red",
        onConfirm: () => { deleteProfile(active.id); }
    });

    return (
        <div className={cl("profiles")}>
            <div className={cl("profile-list")} role="tablist" aria-label={T.profilesAria}>
                {profiles.map(profile => editing === profile.id
                    ? <NameInput key={profile.id} initial={profile.name} onDone={name => finishEditing(profile.id, name)} />
                    : (
                        <button
                            key={profile.id}
                            type="button"
                            role="tab"
                            aria-selected={profile.id === active.id}
                            className={cl("profile", { "profile-active": profile.id === active.id })}
                            onClick={() => void setActiveProfile(profile.id)}
                            onDoubleClick={() => setEditing(profile.id)}
                            title={T.doubleClickRename}
                        >
                            <span className={cl("profile-name")}>{profile.name}</span>
                            <span className={cl("profile-count")}>{profile.images.length}</span>
                        </button>
                    ))}

                {editing === NEW_PROFILE
                    ? <NameInput initial="" onDone={name => finishEditing(NEW_PROFILE, name)} />
                    : profiles.length < MAX_PROFILES && (
                        <button type="button" className={cl("profile-add")} onClick={() => setEditing(NEW_PROFILE)}>
                            <PlusIcon size={14} />
                            {T.newProfile}
                        </button>
                    )}
            </div>

            <div className={cl("profile-tools")}>
                <button type="button" className={cl("icon-button")} title={T.renameProfile(active.name)} onClick={() => setEditing(active.id)}>
                    <PencilIcon width={16} height={16} />
                </button>
                {canDelete && (
                    <button type="button" className={cl("icon-button", "icon-button-danger")} title={T.deleteProfileButton(active.name)} onClick={confirmDelete}>
                        <TrashIcon size={16} />
                    </button>
                )}
            </div>
        </div>
    );
}
