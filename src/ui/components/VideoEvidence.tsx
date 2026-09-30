import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Evidence } from "../../shared/types.ts";

/** Native playback stays opt-in and muted, including when enlarged. */
export function VideoEvidence({ evidence }: { evidence: Evidence }) {
  const video = useRef<HTMLVideoElement>(null);
  const [zoomAt, setZoomAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const label = evidence.caption || "video";
  return (
    <div className="video-evidence">
      <video ref={video} src={evidence.href} controls muted playsInline preload="metadata" aria-label={label} onError={() => setFailed(true)} />
      <div className="row">
        <button className="ghost small" aria-label={`Enlarge ${label}`} onClick={() => {
          video.current?.pause();
          setZoomAt(video.current?.currentTime ?? 0);
        }}>Enlarge video</button>
        <a className="small-note" href={evidence.href} target="_blank" rel="noreferrer">Open video</a>
      </div>
      {failed ? <p className="muted small-note">This browser cannot play this video. Open it to download or try another player.</p> : null}
      {zoomAt !== null ? <VideoZoom evidence={evidence} start={zoomAt} onClose={() => setZoomAt(null)} /> : null}
    </div>
  );
}

function VideoZoom({ evidence, start, onClose }: { evidence: Evidence; start: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return createPortal(
    <dialog ref={dialog} className="video-dialog" aria-label={`Enlarged ${evidence.caption || "video"}`} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => e.stopPropagation()} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="ghost small" autoFocus onClick={onClose}>Close video</button>
      <video src={evidence.href} controls muted playsInline preload="metadata" aria-label={evidence.caption || "video"}
        onLoadedMetadata={(e) => { e.currentTarget.currentTime = start; }} />
    </dialog>, document.body,
  );
}
