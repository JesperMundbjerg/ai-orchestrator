// Images you paste or drop into a message or an answer: uploaded as soon as they arrive, shown
// as thumbnails you can remove before sending, and shown in the thread afterwards.

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 8;

interface Attached {
  key: string;
  /** A local preview, so the thumbnail shows before the upload finishes. */
  preview: string;
  /** The upload id once stored. */
  id: string | null;
}

export interface Attachments {
  items: Attached[];
  ids: string[];
  uploading: boolean;
  error: string | null;
  remove: (key: string) => void;
  clear: () => void;
  onPaste: (e: ClipboardEvent) => void;
  drop: { onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void };
  dragging: boolean;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.readAsDataURL(file);
  });
}

export function useAttachments(): Attachments {
  const [items, setItems] = useState<Attached[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const drop = (key: string) =>
    setItems((all) => {
      const gone = all.find((a) => a.key === key);
      if (gone) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return all.filter((a) => a.key !== key);
    });

  const add = (files: File[]) => {
    const images = files.filter((f) => IMAGE_TYPES.has(f.type));
    if (!images.length) return setError("Only PNG, JPEG, GIF and WebP images can be attached.");
    setError(null);
    const room = MAX_IMAGES - items.length;
    if (images.length > room) setError(`At most ${MAX_IMAGES} images at a time.`);
    for (const file of images.slice(0, Math.max(0, room))) {
      if (file.size > MAX_BYTES) {
        setError(`${file.name || "That image"} is over 10 MB.`);
        continue;
      }
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      setItems((all) => [...all, { key, preview, id: null }]);
      readAsDataUrl(file)
        .then((data) => api.upload(data))
        .then(
          (up) => setItems((all) => all.map((a) => (a.key === key ? { ...a, id: up.id } : a))),
          (e: Error) => (drop(key), setError(e.message)),
        );
    }
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return {
    items,
    ids: items.flatMap((a) => (a.id ? [a.id] : [])),
    uploading: items.some((a) => !a.id),
    error,
    dragging,
    remove: drop,
    clear: () => {
      for (const a of items) {
        URL.revokeObjectURL(a.preview);
        previews.current.delete(a.preview);
      }
      setItems([]);
      setError(null);
    },
    onPaste: (e) => {
      const files = Array.from(e.clipboardData.files);
      if (!files.length) return;
      // A copied image may come with text too (its address, say); then the text is pasted as well.
      if (!e.clipboardData.getData("text/plain")) e.preventDefault();
      add(files);
    },
    drop: {
      onDragOver: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      onDrop: (e) => {
        setDragging(false);
        if (!hasFiles(e)) return;
        e.preventDefault();
        add(Array.from(e.dataTransfer.files));
      },
    },
  };
}

/** The images waiting to be sent, each with a remove button. */
export function AttachedImages({ attachments }: { attachments: Attachments }) {
  const { items, error, remove } = attachments;
  return (
    <>
      {items.length ? (
        <ul className="attached" aria-label="Images to send">
          {items.map((a, i) => (
            <li key={a.key} className={a.id ? "" : "uploading"}>
              <img src={a.preview} alt={`Image ${i + 1}`} />
              <button type="button" className="attached-remove" aria-label={`Remove image ${i + 1}`} title="Remove" onClick={() => remove(a.key)}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="warn small-note">{error}</div> : null}
    </>
  );
}

/** Images in a thread: thumbnails that open full size. */
export function Images({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  if (!ids.length) return null;
  return (
    <>
      <div className="images">
        {ids.map((id, i) => (
          <button key={id} type="button" className="image-thumb" onClick={() => setOpen(id)} aria-label={`Enlarge image ${i + 1}`}>
            <img src={`/uploads/${id}`} alt={`Image ${i + 1}`} loading="lazy" />
          </button>
        ))}
      </div>
      {/* On the page itself, so no panel it sits in can clip it. */}
      {open
        ? createPortal(
            <div className="lightbox" role="dialog" aria-label="Image" onClick={() => setOpen(null)}>
              <img src={`/uploads/${open}`} alt="" />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
