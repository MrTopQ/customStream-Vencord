/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PREVIEW_WIDTH = 1280;
export const PREVIEW_HEIGHT = 720;
const PREVIEW_QUALITY = 0.7;
const THUMB_WIDTH = 384;
const THUMB_HEIGHT = 216;
const THUMB_QUALITY = 0.82;

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_FILE_SIZE = 8 * 1024 * 1024;

export function isAcceptedFile(file: File): boolean {
    return ACCEPTED_TYPES.includes(file.type) && file.size <= MAX_FILE_SIZE;
}

async function renderCover(source: Blob, width: number, height: number, quality: number): Promise<Blob> {
    const bitmap = await createImageBitmap(source);
    try {
        const scale = Math.max(width / bitmap.width, height / bitmap.height);
        const drawWidth = bitmap.width * scale;
        const drawHeight = bitmap.height * scale;

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas is not available");

        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

        return await canvas.convertToBlob({ type: "image/jpeg", quality });
    } finally {
        bitmap.close();
    }
}

export function toPreviewImage(file: Blob): Promise<Blob> {
    return renderCover(file, PREVIEW_WIDTH, PREVIEW_HEIGHT, PREVIEW_QUALITY);
}

export function makeThumbnail(image: Blob): Promise<Blob> {
    return renderCover(image, THUMB_WIDTH, THUMB_HEIGHT, THUMB_QUALITY);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export function downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
