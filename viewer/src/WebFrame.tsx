import { phaseLabel, repoName, type ShareDevice } from "./api.ts";

interface Props {
  shareId: string;
  device: ShareDevice;
  repo: string;
  branch: string;
}

/**
 * A web preview: no device canvas, just the running dev server rendered in an
 * iframe pointed at the share's reverse-proxy base. Shows the same calm building
 * narrative as a device frame until the dev server is ready.
 */
export function WebFrame({ shareId, device, repo, branch }: Props) {
  const ready = device.phase === "ready";
  const src = `/s/${encodeURIComponent(shareId)}/web/`;
  return (
    <figure className="web-frame" data-device-id={device.deviceId}>
      <div className="web-screen">
        {ready ? (
          <iframe className="web-iframe" src={src} title={repoName(repo) || "web preview"} />
        ) : (
          <div className={`overlay ${device.phase === "failed" ? "overlay-failed" : ""}`}>
            {device.phase !== "failed" && <span className="spinner" aria-hidden />}
            <p>{phaseLabel(device.phase, device.detail)}</p>
          </div>
        )}
      </div>
      <figcaption>
        <span className="cap-model">{device.label}</span>
        <span className="cap-repo">
          {repoName(repo)}
          {branch ? <span className="cap-branch"> · {branch}</span> : null}
        </span>
      </figcaption>
    </figure>
  );
}
