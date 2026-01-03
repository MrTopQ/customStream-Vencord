/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { ImageIcon } from "@components/Icons";
import { Alerts } from "@webpack/common";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, Menu, React, showToast, Text, Toasts, UserStore, useState, useEffect, useRef } from "@webpack/common";

const PanelButton = findComponentByCodeLazy(".greenTooltip,", ".greenTooltipContent");

const DATASTORE_KEY = "CustomStreamTopQ_ImageData";
const DATASTORE_KEY_SLIDESHOW = "CustomStreamTopQ_Slideshow";
const DATASTORE_KEY_INDEX = "CustomStreamTopQ_SlideIndex";
const MAX_IMAGES = 50;

// Кэш для изображений в памяти
let cachedImages: Blob[] = [];
let cachedDataUris: string[] = [];
let currentSlideIndex = 0;
let lastSlideChangeTime = 0; // Время последней смены слайда (timestamp)
let isStreamActive = false; // Активен ли стрим сейчас
let manualSlideChange = false; // Флаг ручной смены картинки через модалку
let actualStreamImageUri: string | null = null; // Реальная картинка которая СЕЙЧАС на стриме (обновляется только Discord'ом)

// Слушатели для обновления UI
const imageChangeListeners = new Set<() => void>();

function notifyImageChange() {
    imageChangeListeners.forEach(listener => listener());
}

const settings = definePluginSettings({
    replaceEnabled: {
        type: OptionType.BOOLEAN,
        description: "Use custom preview instead of screen capture",
        default: true
    },
    slideshowEnabled: {
        type: OptionType.BOOLEAN,
        description: "Slideshow mode (switch images every ~5 min)",
        default: false
    },
    slideshowRandom: {
        type: OptionType.BOOLEAN,
        description: "Random slide order",
        default: false
    }
});

// Структура данных для хранения
interface StoredImageData {
    type: string;
    data: number[];
}

interface SlideshowData {
    images: StoredImageData[];
}

// Функции для работы с DataStore
async function saveSlideIndex(index: number): Promise<void> {
    await DataStore.set(DATASTORE_KEY_INDEX, index);
}

async function loadSlideIndex(): Promise<number> {
    const index = await DataStore.get(DATASTORE_KEY_INDEX);
    return typeof index === "number" ? index : 0;
}

async function saveImagesToDataStore(blobs: Blob[]): Promise<void> {
    const images: StoredImageData[] = [];

    for (const blob of blobs) {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        images.push({
            type: blob.type,
            data: Array.from(uint8Array)
        });
    }

    await DataStore.set(DATASTORE_KEY_SLIDESHOW, { images });
    cachedImages = blobs;

    await prepareCachedDataUris();
    notifyImageChange();
}

async function loadImagesFromDataStore(): Promise<Blob[]> {
    try {
        // Сначала пробуем загрузить слайд-шоу
        const slideshowData: SlideshowData | undefined = await DataStore.get(DATASTORE_KEY_SLIDESHOW);
        if (slideshowData?.images?.length) {
            const blobs: Blob[] = [];
            for (const img of slideshowData.images) {
                const uint8Array = new Uint8Array(img.data);
                blobs.push(new Blob([uint8Array], { type: img.type }));
            }
            cachedImages = blobs;
            return blobs;
        }

        // Fallback: загружаем старый формат (одна картинка)
        const oldData = await DataStore.get(DATASTORE_KEY);
        if (oldData?.data && oldData?.type) {
            const uint8Array = new Uint8Array(oldData.data);
            const blob = new Blob([uint8Array], { type: oldData.type });
            cachedImages = [blob];
            // Мигрируем на новый формат
            await saveImagesToDataStore([blob]);
            await DataStore.del(DATASTORE_KEY);
            return [blob];
        }

        return [];
    } catch (error) {
        console.error("[CustomStreamTopQ] Error loading images:", error);
        return [];
    }
}

async function deleteAllImages(): Promise<void> {
    await DataStore.del(DATASTORE_KEY_SLIDESHOW);
    await DataStore.del(DATASTORE_KEY);
    cachedImages = [];
    cachedDataUris = [];
    currentSlideIndex = 0;
    notifyImageChange();
}

async function deleteImageAtIndex(index: number): Promise<void> {
    if (index < 0 || index >= cachedImages.length) return;

    cachedImages.splice(index, 1);
    cachedDataUris.splice(index, 1);

    if (currentSlideIndex >= cachedImages.length) {
        currentSlideIndex = 0;
    }

    await saveImagesToDataStore(cachedImages);
}

async function moveImage(fromIndex: number, toIndex: number): Promise<void> {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= cachedImages.length) return;
    if (toIndex < 0 || toIndex >= cachedImages.length) return;

    // Перемещаем blob
    const [movedBlob] = cachedImages.splice(fromIndex, 1);
    cachedImages.splice(toIndex, 0, movedBlob);

    // Перемещаем data uri
    const [movedUri] = cachedDataUris.splice(fromIndex, 1);
    cachedDataUris.splice(toIndex, 0, movedUri);

    // Корректируем currentSlideIndex
    if (currentSlideIndex === fromIndex) {
        currentSlideIndex = toIndex;
    } else if (fromIndex < currentSlideIndex && toIndex >= currentSlideIndex) {
        currentSlideIndex--;
    } else if (fromIndex > currentSlideIndex && toIndex <= currentSlideIndex) {
        currentSlideIndex++;
    }

    await saveImagesToDataStore(cachedImages);
}

async function addImage(blob: Blob): Promise<void> {
    cachedImages.push(blob);
    await saveImagesToDataStore(cachedImages);
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function prepareCachedDataUris(): Promise<void> {
    cachedDataUris = [];
    for (const blob of cachedImages) {
        try {
            const uri = await blobToDataUrl(blob);
            cachedDataUris.push(uri);
        } catch (e) {
            console.error("[CustomStreamTopQ] Error converting blob:", e);
        }
    }
}

function getImageCount(): number {
    return cachedImages.length;
}

// Конвертация изображения в JPEG и масштабирование до 1280x720
async function processImage(blob: Blob): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        img.onload = () => {
            URL.revokeObjectURL(url);

            const targetWidth = 1280;
            const targetHeight = 720;

            // Создаём canvas для конвертации и масштабирования
            const canvas = document.createElement("canvas");
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext("2d")!;

            // Заливаем чёрным фоном (на случай прозрачности)
            ctx.fillStyle = "#000000";
            ctx.fillRect(0, 0, targetWidth, targetHeight);

            // Вычисляем размеры для сохранения пропорций (cover)
            const scale = Math.max(targetWidth / img.width, targetHeight / img.height);
            const scaledWidth = img.width * scale;
            const scaledHeight = img.height * scale;
            const x = (targetWidth - scaledWidth) / 2;
            const y = (targetHeight - scaledHeight) / 2;

            ctx.drawImage(img, x, y, scaledWidth, scaledHeight);

            // Discord использует JPEG для превью стримов
            // Качество 0.7 для уменьшения размера (Discord ограничивает ~100KB)
            canvas.toBlob((newBlob) => {
                if (newBlob) {
                    resolve(newBlob);
                } else {
                    reject(new Error("Failed to convert image"));
                }
            }, "image/jpeg", 0.7);
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Failed to load image"));
        };

        img.src = url;
    });
}

function ImagePickerModal({ rootProps }: { rootProps: any; }) {
    // Сохраняем исходные значения для отката
    const initialSettingsRef = useRef({
        enabled: settings.store.replaceEnabled,
        slideshowEnabled: settings.store.slideshowEnabled,
        slideshowRandom: settings.store.slideshowRandom,
        slideIndex: currentSlideIndex
    });
    const savedRef = useRef(false);

    const [images, setImages] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");
    const [pendingIndex, setPendingIndex] = useState(currentSlideIndex);
    const [pluginEnabled, setPluginEnabled] = useState(settings.store.replaceEnabled);
    const [slideshowOn, setSlideshowOn] = useState(settings.store.slideshowEnabled);
    const [randomOn, setRandomOn] = useState(settings.store.slideshowRandom);
    const [isDragging, setIsDragging] = useState(false);
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const [timerSeconds, setTimerSeconds] = useState(0);
    const [streamActive, setStreamActive] = useState(isStreamActive);

    // Откат при закрытии без сохранения (ESC, клик вне окна, крестик)
    useEffect(() => {
        return () => {
            if (!savedRef.current) {
                // Откатываем настройки при закрытии без сохранения
                const init = initialSettingsRef.current;
                settings.store.replaceEnabled = init.enabled;
                settings.store.slideshowEnabled = init.slideshowEnabled;
                settings.store.slideshowRandom = init.slideshowRandom;
                currentSlideIndex = init.slideIndex;
            }
        };
    }, []);

    const loadImages = async () => {
        setIsLoading(true);
        const uris: string[] = [];
        for (const blob of cachedImages) {
            try {
                const uri = await blobToDataUrl(blob);
                uris.push(uri);
            } catch (e) {
                console.error("[CustomStreamTopQ] Error:", e);
            }
        }
        setImages(uris);
        setIsLoading(false);
    };

    useEffect(() => {
        loadImages();
    }, []);

    // Таймер для обновления времени в модалке
    useEffect(() => {
        const timerInterval = setInterval(() => {
            // Автосброс: если прошло более 7 минут без вызова getCustomThumbnail - стрим остановлен
            if (isStreamActive && lastSlideChangeTime > 0 && (Date.now() - lastSlideChangeTime) > 420000) {
                isStreamActive = false;
            }
            setStreamActive(isStreamActive);
            if (lastSlideChangeTime > 0 && isStreamActive) {
                setTimerSeconds(Math.floor((Date.now() - lastSlideChangeTime) / 1000));
            }
        }, 1000);
        return () => clearInterval(timerInterval);
    }, []);

    // Обработка перетаскиваемых файлов
    const handleDroppedFiles = async (files: FileList | File[]) => {
        const remaining = MAX_IMAGES - cachedImages.length;
        if (remaining <= 0) {
            setError(`Limit of ${MAX_IMAGES} images reached!`);
            return;
        }

        setIsLoading(true);
        setError("");

        try {
            let added = 0;
            for (const file of files) {
                if (added >= remaining) {
                    setError(`Added ${added}. Limit of ${MAX_IMAGES} reached!`);
                    break;
                }
                if (!file.type.startsWith("image/") || file.type === "image/gif") {
                    continue;
                }
                if (file.size > 8 * 1024 * 1024) {
                    continue;
                }

                const processedBlob = await processImage(file);
                await addImage(processedBlob);
                added++;
            }

            await loadImages();
            if (added > 0) {
                showToast(`Added: ${added}`, Toasts.Type.SUCCESS);
            }
        } catch {
            setError("File processing error");
        }

        setIsLoading(false);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Показываем полоску только если это файлы извне, а не перетаскивание фото внутри
        if (draggedIndex === null && e.dataTransfer.types.includes("Files")) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Проверяем что действительно покинули область
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            setIsDragging(false);
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            await handleDroppedFiles(files);
        }
    };

    const handleFileSelect = (multiple: boolean) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp";
        input.multiple = multiple;
        input.onchange = async (e: any) => {
            const files = e.target.files;
            if (!files?.length) return;

            // Проверяем лимит
            const remaining = MAX_IMAGES - cachedImages.length;
            if (remaining <= 0) {
                setError(`Limit of ${MAX_IMAGES} images reached!`);
                return;
            }

            setIsLoading(true);
            setError("");

            try {
                let added = 0;
                for (const file of files) {
                    if (added >= remaining) {
                        setError(`Added ${added}. Limit of ${MAX_IMAGES} reached!`);
                        break;
                    }
                    if (file.type === "image/gif" || file.type.startsWith("video/")) {
                        continue;
                    }
                    if (file.size > 8 * 1024 * 1024) {
                        continue;
                    }

                    const processedBlob = await processImage(file);
                    await addImage(processedBlob);
                    added++;
                }

                await loadImages();
                if (added > 0) {
                    showToast(`Added: ${added}`, Toasts.Type.SUCCESS);
                }
            } catch {
                setError("File processing error");
            }

            setIsLoading(false);
        };
        input.click();
    };

    const handleDelete = async (index: number) => {
        await deleteImageAtIndex(index);
        if (pendingIndex >= cachedImages.length && cachedImages.length > 0) {
            setPendingIndex(cachedImages.length - 1);
        } else if (cachedImages.length === 0) {
            setPendingIndex(0);
        }
        await loadImages();
        showToast("Deleted", Toasts.Type.MESSAGE);
    };

    const handleClearAll = async () => {
        Alerts.show({
            title: "Delete all images?",
            body: `Are you sure you want to delete all ${images.length} images? This action cannot be undone.`,
            confirmText: "Delete All",
            cancelText: "Cancel",
            confirmColor: "red",
            onConfirm: async () => {
                await deleteAllImages();
                setImages([]);
                setPendingIndex(0);
                showToast("All deleted", Toasts.Type.MESSAGE);
            }
        });
    };

    const handleSelectCurrent = (index: number) => {
        setPendingIndex(index);
    };

    const togglePlugin = () => {
        setPluginEnabled(!pluginEnabled);
    };

    const toggleSlideshow = () => {
        setSlideshowOn(!slideshowOn);
    };

    const toggleRandom = () => {
        setRandomOn(!randomOn);
    };

    const handleSave = async () => {
        // Применяем все изменения
        settings.store.replaceEnabled = pluginEnabled;
        settings.store.slideshowEnabled = slideshowOn;
        settings.store.slideshowRandom = randomOn;

        // Проверяем была ли ручная смена картинки
        if (pendingIndex !== currentSlideIndex) {
            manualSlideChange = true; // Помечаем что была ручная смена
            // НЕ сбрасываем таймер при ручной смене!
        }

        currentSlideIndex = pendingIndex;
        await saveSlideIndex(pendingIndex); // Сохраняем индекс в DataStore
        savedRef.current = true; // Помечаем что сохранили
        notifyImageChange(); // Обновляем иконку в панели
        showToast("Settings saved!", Toasts.Type.SUCCESS);
        rootProps.onClose();
    };

    const handleCancel = () => {
        // saved остаётся false, откат произойдёт в useEffect при размонтировании
        rootProps.onClose();
    };

    // Drag & drop для изменения порядка
    const handleImageDragStart = (e: React.DragEvent, index: number) => {
        e.stopPropagation();
        setDraggedIndex(index);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", index.toString());
    };

    const handleImageDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (draggedIndex !== null && draggedIndex !== index) {
            setDragOverIndex(index);
        }
    };

    const handleImageDragLeave = (e: React.DragEvent) => {
        e.stopPropagation();
        setDragOverIndex(null);
    };

    const handleImageDrop = async (e: React.DragEvent, toIndex: number) => {
        e.preventDefault();
        e.stopPropagation();

        if (draggedIndex !== null && draggedIndex !== toIndex) {
            // Корректируем pendingIndex при перемещении
            let newPendingIndex = pendingIndex;
            if (pendingIndex === draggedIndex) {
                newPendingIndex = toIndex;
            } else if (draggedIndex < pendingIndex && toIndex >= pendingIndex) {
                newPendingIndex--;
            } else if (draggedIndex > pendingIndex && toIndex <= pendingIndex) {
                newPendingIndex++;
            }

            await moveImage(draggedIndex, toIndex);
            setPendingIndex(newPendingIndex);
            await loadImages();
            showToast(`Moved: #${draggedIndex + 1} → #${toIndex + 1}`, Toasts.Type.SUCCESS);
        }

        setDraggedIndex(null);
        setDragOverIndex(null);
    };

    const handleImageDragEnd = () => {
        setDraggedIndex(null);
        setDragOverIndex(null);
    };

    // Вычисляем следующий индекс
    const getNextIndex = () => {
        if (images.length <= 1 || !slideshowOn) return -1;
        if (randomOn) return -1;
        return (pendingIndex + 1) % images.length;
    };

    const nextIndex = getNextIndex();

    return (
        <ModalRoot {...rootProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Stream Preview
                </Text>
                <ModalCloseButton onClick={handleCancel} />
            </ModalHeader>
            <ModalContent>
                <div
                    style={{ padding: "16px", position: "relative" }}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >

                    {/* Оверлей для drag & drop файлов - только верх до галереи */}
                    {isDragging && draggedIndex === null && (
                        <div
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop}
                            style={{
                                position: "absolute",
                                top: "8px",
                                left: "8px",
                                right: "8px",
                                bottom: "400px",
                                backgroundColor: "rgba(88, 101, 242, 0.95)",
                                borderRadius: "8px",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                zIndex: 1000,
                                border: "3px dashed white",
                                pointerEvents: "auto"
                            }}>
                            <Text variant="heading-xl/bold" style={{ color: "white", marginBottom: "8px" }}>
                                📥 Drop to upload
                            </Text>
                            <Text variant="text-md/normal" style={{ color: "rgba(255,255,255,0.8)" }}>
                                Supports PNG, JPEG, WebP
                            </Text>
                        </div>
                    )}

                    {/* Главный переключатель */}
                    <div
                        onClick={togglePlugin}
                        style={{
                            padding: "12px 16px",
                            borderRadius: "8px",
                            marginBottom: "16px",
                            cursor: "pointer",
                            backgroundColor: pluginEnabled ? "#3ba55c" : "#ed4245",
                            color: "white",
                            fontWeight: "600",
                            fontSize: "14px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "8px",
                            transition: "background-color 0.2s"
                        }}
                    >
                        {pluginEnabled ? "✅ REPLACEMENT ENABLED" : "❌ REPLACEMENT DISABLED (default Discord)"}
                    </div>

                    {/* Режимы слайд-шоу */}
                    <div style={{
                        display: "flex",
                        gap: "8px",
                        marginBottom: "16px"
                    }}>
                        <div
                            onClick={toggleSlideshow}
                            style={{
                                flex: 1,
                                padding: "10px 16px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                backgroundColor: slideshowOn ? "#5865F2" : "#4f545c",
                                color: "white",
                                fontWeight: "600",
                                fontSize: "13px",
                                textAlign: "center",
                                transition: "background-color 0.2s"
                            }}
                        >
                            🎞️ Slideshow: {slideshowOn ? "ON" : "OFF"}
                        </div>
                        <div
                            onClick={slideshowOn ? toggleRandom : undefined}
                            style={{
                                flex: 1,
                                padding: "10px 16px",
                                borderRadius: "6px",
                                cursor: slideshowOn ? "pointer" : "not-allowed",
                                backgroundColor: slideshowOn && randomOn ? "#5865F2" : "#4f545c",
                                color: "white",
                                fontWeight: "600",
                                fontSize: "13px",
                                textAlign: "center",
                                opacity: slideshowOn ? 1 : 0.5,
                                transition: "background-color 0.2s"
                            }}
                        >
                            🎲 Random: {randomOn ? "YES" : "NO"}
                        </div>
                    </div>

                    {/* Инфо */}
                    <div style={{
                        padding: "8px 12px",
                        backgroundColor: "var(--background-secondary)",
                        borderRadius: "4px",
                        marginBottom: "16px"
                    }}>
                        <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                            📊 Images: <strong>{images.length}/{MAX_IMAGES}</strong>
                            {images.length > 0 && (
                                <> | 📍 Selected: <strong>#{pendingIndex + 1}</strong></>
                            )}
                            {images.length > 1 && slideshowOn && pluginEnabled && (
                                <> | {streamActive ? "🟢" : "⚫"} Change ~5 min</>
                            )}
                            {images.length > 0 && pluginEnabled && streamActive && lastSlideChangeTime > 0 && (
                                <> | ⏱️ {formatTime(timerSeconds)} (~{formatTime(Math.max(0, 300 - timerSeconds))})</>
                            )}
                        </Text>
                    </div>

                    {/* Кнопки */}
                    <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
                        <Button
                            onClick={() => handleFileSelect(false)}
                            disabled={isLoading || images.length >= MAX_IMAGES}
                        >
                            {isLoading ? "⏳..." : "📁 Add Image"}
                        </Button>
                        <Button
                            onClick={() => handleFileSelect(true)}
                            disabled={isLoading || images.length >= MAX_IMAGES}
                        >
                            📁+ Multiple
                        </Button>
                        <Button color="red" onClick={handleClearAll} disabled={images.length === 0}>
                            🗑️ Delete All
                        </Button>
                    </div>

                    {error && (
                        <div style={{
                            padding: "8px 12px",
                            backgroundColor: "var(--status-danger-background)",
                            borderRadius: "4px",
                            marginBottom: "16px",
                            color: "var(--status-danger)"
                        }}>
                            ❌ {error}
                        </div>
                    )}

                    {/* Подсказка */}
                    {images.length > 1 && (
                        <Text variant="text-sm/normal" style={{ marginBottom: "12px", color: "var(--text-muted)" }}>
                            💡 Click to select. Drag to reorder.
                        </Text>
                    )}

                    {images.length > 0 ? (
                        <div style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                            gap: "12px",
                            maxHeight: "350px",
                            overflowY: "auto",
                            padding: "4px"
                        }}>
                            {images.map((src, index) => {
                                const isCurrent = index === pendingIndex;
                                const isNext = index === nextIndex;
                                const isBeingDragged = index === draggedIndex;
                                const isDragTarget = index === dragOverIndex;

                                return (
                                    <div
                                        key={index}
                                        draggable
                                        onClick={() => handleSelectCurrent(index)}
                                        onDragStart={(e) => handleImageDragStart(e, index)}
                                        onDragOver={(e) => handleImageDragOver(e, index)}
                                        onDragLeave={handleImageDragLeave}
                                        onDrop={(e) => handleImageDrop(e, index)}
                                        onDragEnd={handleImageDragEnd}
                                        style={{
                                            position: "relative",
                                            borderRadius: "8px",
                                            overflow: "hidden",
                                            border: isDragTarget
                                                ? "3px solid #faa61a"
                                                : isCurrent
                                                    ? "3px solid #3ba55c"
                                                    : isNext
                                                        ? "3px solid #5865F2"
                                                        : "2px solid var(--background-tertiary)",
                                            backgroundColor: "var(--background-secondary)",
                                            boxShadow: isDragTarget
                                                ? "0 0 12px #faa61a"
                                                : isCurrent
                                                    ? "0 0 12px #3ba55c"
                                                    : isNext
                                                        ? "0 0 8px #5865F2"
                                                        : "none",
                                            cursor: "grab",
                                            opacity: isBeingDragged ? 0.5 : 1,
                                            transition: "transform 0.1s, box-shadow 0.1s, opacity 0.1s"
                                        }}
                                        onMouseEnter={e => {
                                            if (!isCurrent && !isBeingDragged) (e.currentTarget as HTMLElement).style.transform = "scale(1.03)";
                                        }}
                                        onMouseLeave={e => {
                                            (e.currentTarget as HTMLElement).style.transform = "scale(1)";
                                        }}
                                    >
                                        <img
                                            src={src}
                                            alt={`Slide ${index + 1}`}
                                            style={{
                                                width: "100%",
                                                height: "100px",
                                                objectFit: "cover",
                                                display: "block"
                                            }}
                                        />
                                        <div style={{
                                            position: "absolute",
                                            top: "4px",
                                            left: "4px",
                                            backgroundColor: isCurrent
                                                ? "#3ba55c"
                                                : isNext
                                                    ? "#5865F2"
                                                    : "rgba(0,0,0,0.7)",
                                            color: "white",
                                            padding: "2px 6px",
                                            borderRadius: "4px",
                                            fontSize: "11px",
                                            fontWeight: isCurrent || isNext ? "bold" : "normal"
                                        }}>
                                            {isCurrent && "▶ "}
                                            {isNext && "→ "}
                                            #{index + 1}
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                const a = document.createElement("a");
                                                a.href = src;
                                                a.download = `stream-preview-${index + 1}.jpg`;
                                                a.click();
                                            }}
                                            style={{
                                                position: "absolute",
                                                top: "4px",
                                                right: "30px",
                                                backgroundColor: "#5865F2",
                                                color: "white",
                                                border: "none",
                                                borderRadius: "4px",
                                                width: "22px",
                                                height: "22px",
                                                cursor: "pointer",
                                                fontSize: "12px"
                                            }}
                                        >
                                            ⬇
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDelete(index);
                                            }}
                                            style={{
                                                position: "absolute",
                                                top: "4px",
                                                right: "4px",
                                                backgroundColor: "#ed4245",
                                                color: "white",
                                                border: "none",
                                                borderRadius: "4px",
                                                width: "22px",
                                                height: "22px",
                                                cursor: "pointer",
                                                fontSize: "12px"
                                            }}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div style={{
                            padding: "40px",
                            textAlign: "center",
                            backgroundColor: "var(--background-secondary)",
                            borderRadius: "8px",
                            border: "2px dashed var(--background-tertiary)"
                        }}>
                            <Text variant="text-lg/normal" style={{ color: "var(--text-muted)", marginBottom: "8px" }}>
                                📷 No images
                            </Text>
                            <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                                Drag images here or click "Add Image"
                            </Text>
                        </div>
                    )}

                    {/* Подсказка про хранение */}
                    <Text variant="text-xs/normal" style={{ marginTop: "16px", color: "var(--text-muted)" }}>
                        💾 Images stored locally. Limit: {MAX_IMAGES} images.
                    </Text>
                </div>
            </ModalContent>
            <ModalFooter>
                <div style={{ display: "flex", gap: "8px", width: "100%", justifyContent: "flex-end" }}>
                    <Button onClick={handleCancel}>
                        ✕ Cancel
                    </Button>
                    <Button color="green" onClick={handleSave}>
                        ✓ Save
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

function openImagePicker() {
    openModal((props: any) => <ImagePickerModal rootProps={props} />);
}

// Иконка для кнопки панели с бейджем количества
function StreamPreviewIcon({ imageCount, isEnabled, isSlideshowEnabled, isRandom, currentImageUri, streamActive }: {
    imageCount: number;
    isEnabled: boolean;
    isSlideshowEnabled: boolean;
    isRandom: boolean;
    currentImageUri: string | null;
    streamActive: boolean;
}) {
    return (
        <div style={{ position: "relative" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                {/* Рамка монитора - всегда currentColor */}
                <path
                    fill="currentColor"
                    d="M21 3H3C1.9 3 1 3.9 1 5V17C1 18.1 1.9 19 3 19H8V21H16V19H21C22.1 19 23 18.1 23 17V5C23 3.9 22.1 3 21 3ZM21 17H3V5H21V17Z"
                />
                {/* Внутренняя часть - зелёные горы если плагин активен, серые если выключен */}
                <path
                    fill={isEnabled ? "var(--status-positive)" : "currentColor"}
                    d="M12 7C10.34 7 9 8.34 9 10C9 11.66 10.34 13 12 13C13.66 13 15 11.66 15 10C15 8.34 13.66 7 12 7Z"
                />
                <path
                    fill={isEnabled ? "var(--status-positive)" : "currentColor"}
                    d="M18 14L15 11L12 14L9 11L6 14V15H18V14Z"
                />
            </svg>

            {/* Бейдж с количеством - показываем если больше 1 и включён слайдшоу */}
            {imageCount > 1 && isSlideshowEnabled && isEnabled && (
                <div style={{
                    position: "absolute",
                    top: "-4px",
                    right: "-6px",
                    backgroundColor: "var(--status-positive)",
                    color: "white",
                    fontSize: "9px",
                    fontWeight: "bold",
                    borderRadius: "6px",
                    minWidth: "12px",
                    height: "12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 3px"
                }}>
                    {imageCount}
                </div>
            )}

            {/* Знак случайности 🎲 - показываем если случайный режим */}
            {imageCount > 1 && isSlideshowEnabled && isRandom && isEnabled && (
                <div style={{
                    position: "absolute",
                    bottom: "-4px",
                    right: "-6px",
                    fontSize: "10px",
                    lineHeight: "1"
                }}>
                    🎲
                </div>
            )}
        </div>
    );
}

// Форматирование времени в удобный вид
function formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds} sec`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (secs === 0) return `${mins} min`;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Кнопка в панели аккаунта 
function StreamPreviewPanelButton(props?: any) {
    const [imageCount, setImageCount] = useState(0);
    const [isEnabled, setIsEnabled] = useState(settings.store.replaceEnabled);
    const [isSlideshowEnabled, setIsSlideshowEnabled] = useState(settings.store.slideshowEnabled);
    const [isRandom, setIsRandom] = useState(settings.store.slideshowRandom);
    const [currentIndex, setCurrentIndex] = useState(currentSlideIndex);
    const [secondsAgo, setSecondsAgo] = useState(0);
    const [streamActive, setStreamActive] = useState(isStreamActive);
    const [currentImageUri, setCurrentImageUri] = useState<string | null>(null);

    useEffect(() => {
        const updateState = () => {
            setImageCount(getImageCount());
            setIsEnabled(settings.store.replaceEnabled);
            setIsSlideshowEnabled(settings.store.slideshowEnabled);
            setIsRandom(settings.store.slideshowRandom);
            setCurrentIndex(currentSlideIndex);
            setStreamActive(isStreamActive);
            // Обновляем превью РЕАЛЬНОЙ картинки на стриме 
            setCurrentImageUri(actualStreamImageUri);
        };

        updateState();
        imageChangeListeners.add(updateState);

        // Таймер для обновления времени каждую секунду
        const timerInterval = setInterval(() => {
            // Автосброс: если прошло более 7 минут без вызова getCustomThumbnail - стрим остановлен
            if (isStreamActive && lastSlideChangeTime > 0 && (Date.now() - lastSlideChangeTime) > 420000) {
                isStreamActive = false;
            }
            setStreamActive(isStreamActive);
            if (lastSlideChangeTime > 0 && isStreamActive) {
                setSecondsAgo(Math.floor((Date.now() - lastSlideChangeTime) / 1000));
            }
        }, 1000);

        return () => {
            imageChangeListeners.delete(updateState);
            clearInterval(timerInterval);
        };
    }, []);

    const getTooltip = () => {
        if (imageCount === 0) return "Select stream preview";
        if (!isEnabled) return `Stream preview (disabled, ${imageCount} images)`;

        // Таймер для любого количества фото (включая 1)
        const timeInfo = lastSlideChangeTime > 0 && streamActive
            ? `\n⏱️ ${formatTime(secondsAgo)} ago (~${formatTime(Math.max(0, 300 - secondsAgo))} until update)`
            : streamActive ? "" : "\n⚫ Stream not active";

        if (imageCount === 1) return `Stream preview (1 image)${timeInfo}`;

        if (isSlideshowEnabled) {
            const slideInfo = `\n📍 Current: #${currentIndex + 1}`;
            if (isRandom) {
                return `Stream preview (${imageCount} images, random)${slideInfo}${timeInfo}`;
            }
            return `Stream preview (${imageCount} images, slideshow)${slideInfo}${timeInfo}`;
        }
        return `Stream preview (${imageCount} images)${timeInfo}`;
    };

    // Кастомный тултип с превью картинки
    const renderTooltip = () => {
        const tooltipText = getTooltip();

        // Показываем превью только если: есть картинка, плагин включен, есть фото И стрим активен
        if (currentImageUri && isEnabled && imageCount > 0 && streamActive) {
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "center" }}>
                    <div style={{
                        width: "160px",
                        height: "90px",
                        borderRadius: "4px",
                        overflow: "hidden",
                        border: "2px solid var(--status-positive)",
                        boxShadow: "0 0 8px rgba(59, 165, 92, 0.5)"
                    }}>
                        <img
                            src={currentImageUri}
                            alt="Preview"
                            style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                                display: "block"
                            }}
                        />
                    </div>
                    <div style={{
                        whiteSpace: "pre-line",
                        textAlign: "center",
                        fontSize: "12px",
                        lineHeight: "1.4"
                    }}>
                        {tooltipText}
                    </div>
                </div>
            );
        }

        return tooltipText;
    };

    return (
        <PanelButton
            tooltipText={renderTooltip()}
            icon={() => <StreamPreviewIcon
                imageCount={imageCount}
                isEnabled={isEnabled}
                isSlideshowEnabled={isSlideshowEnabled}
                isRandom={isRandom}
                currentImageUri={currentImageUri}
                streamActive={streamActive}
            />}
            onClick={openImagePicker}
        />
    );
}

// Патч контекстного меню стрима
interface StreamContextProps {
    stream: {
        ownerId: string;
        guildId: string | null;
        channelId: string;
    };
}

const streamContextMenuPatch: NavContextMenuPatchCallback = (children, { stream }: StreamContextProps) => {
    // Проверяем, что это наш стрим
    const currentUser = UserStore.getCurrentUser();
    if (!currentUser || stream.ownerId !== currentUser.id) return;

    // Находим группу с "Полный экран" и "Открыть в отдельном окне"
    const group = findGroupChildrenByChildId(["fullscreen", "popout"], children);

    if (group) {
        // Добавляем наш пункт после существующих
        group.push(
            <Menu.MenuItem
                id="custom-stream-preview"
                label="🖼️ Custom Preview"
                icon={ImageIcon}
                action={openImagePicker}
            />
        );
    } else {
        // Если группа не найдена, добавляем в конец
        children.push(
            <Menu.MenuSeparator />,
            <Menu.MenuItem
                id="custom-stream-preview"
                label="🖼️ Custom Preview"
                icon={ImageIcon}
                action={openImagePicker}
            />
        );
    }
};

// Функция для получения кастомного превью (вызывается из webpack patch)
// При слайд-шоу каждый вызов (~5 мин) возвращает следующую картинку
function getCustomThumbnail(originalThumbnail: string): string {
    // Помечаем что стрим активен
    isStreamActive = true;

    if (!settings.store.replaceEnabled || cachedDataUris.length === 0) {
        actualStreamImageUri = null; // Нет кастомной картинки
        notifyImageChange();
        return originalThumbnail;
    }

    // Если одна картинка или слайд-шоу выключено — показываем выбранную
    if (cachedDataUris.length === 1 || !settings.store.slideshowEnabled) {
        // Проверяем что индекс валиден
        const idx = currentSlideIndex < cachedDataUris.length ? currentSlideIndex : 0;
        lastSlideChangeTime = Date.now(); // Обновляем время для таймера
        actualStreamImageUri = cachedDataUris[idx]; // Обновляем реальную картинку на стриме
        notifyImageChange();
        return cachedDataUris[idx];
    }

    // Если была ручная смена — показываем выбранную картинку один раз
    if (manualSlideChange) {
        manualSlideChange = false; // Сбрасываем флаг
        lastSlideChangeTime = Date.now(); // Обновляем время для таймера
        actualStreamImageUri = cachedDataUris[currentSlideIndex]; // Обновляем реальную картинку на стриме
        notifyImageChange();
        return cachedDataUris[currentSlideIndex];
    }

    // Слайд-шоу: выбираем следующую картинку
    let nextIndex: number;

    if (settings.store.slideshowRandom) {
        // Случайный выбор (но не та же самая)
        do {
            nextIndex = Math.floor(Math.random() * cachedDataUris.length);
        } while (nextIndex === currentSlideIndex && cachedDataUris.length > 1);
    } else {
        // Последовательный выбор
        nextIndex = (currentSlideIndex + 1) % cachedDataUris.length;
    }

    currentSlideIndex = nextIndex;
    lastSlideChangeTime = Date.now(); // Запоминаем время смены
    actualStreamImageUri = cachedDataUris[currentSlideIndex]; // Обновляем реальную картинку на стриме
    saveSlideIndex(nextIndex); // Сохраняем новый индекс
    notifyImageChange(); // Обновляем UI
    return cachedDataUris[currentSlideIndex];
}

export default definePlugin({
    name: "CustomStreamTopQ",
    description: "Allows you to set a custom image for stream preview instead of screen capture. Intercepts Discord requests to update preview.",
    authors: [{ name: "User", id: 0n }],

    settings,

    // Патчи для перехвата функции обновления превью
    patches: [
        {
            find: "#{intl::ACCOUNT_SPEAKING_WHILE_MUTED}",
            replacement: {
                match: /className:\i\.buttons,.{0,50}children:\[/,
                replace: "$&$self.StreamPreviewPanelButton(arguments[0]),"
            }
        },
        {
            // Перехватываем отправку превью в ApplicationStreamPreviewUploadManager
            find: "\"ApplicationStreamPreviewUploadManager\"",
            all: true,
            replacement: [
                {
                    // Паттерн 1: body:{thumbnail:x}
                    match: /body:\{thumbnail:(\i)\}/,
                    replace: "body:{thumbnail:$self.getCustomThumbnail($1)}"
                },
                {
                    // Паттерн 2: {thumbnail:x} без body
                    match: /\{thumbnail:(\i)\}/,
                    replace: "{thumbnail:$self.getCustomThumbnail($1)}"
                }
            ]
        }
    ],

    toolboxActions: {
        "Select stream preview": openImagePicker
    },

    // Кнопка в панели аккаунта
    StreamPreviewPanelButton: ErrorBoundary.wrap(StreamPreviewPanelButton, { noop: true }),

    // Функция для замены thumbnail (вызывается из webpack patch)
    getCustomThumbnail,

    contextMenus: {
        "stream-context": streamContextMenuPatch
    },

    async start() {
        // Загружаем изображения в кэш при старте
        await loadImagesFromDataStore();

        // Загружаем сохранённый индекс
        currentSlideIndex = await loadSlideIndex();
        // Проверяем что индекс валиден
        if (currentSlideIndex >= cachedImages.length) {
            currentSlideIndex = 0;
        }

        // Подготавливаем Data URI для перехвата
        await prepareCachedDataUris();

        // Уведомляем UI об обновлении (для иконки в панели)
        notifyImageChange();

        console.log(`[CustomStreamTopQ] Loaded ${cachedImages.length} images, current index: ${currentSlideIndex}`);
    },

    stop() {
        // Очищаем кэш при выключении
        cachedImages = [];
        cachedDataUris = [];
        currentSlideIndex = 0;
        isStreamActive = false;
        lastSlideChangeTime = 0;
        manualSlideChange = false;
    }
});
