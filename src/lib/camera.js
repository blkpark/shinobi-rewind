// @ts-check

export const cameraLimit = 7;

/** @param {import("./types").Camera} camera */
export function cameraLabel(camera) {
  const name = camera.name.trim();
  if (/^\d+$/.test(name)) return { title: `CAM-${name}`, subtitle: "" };
  if (/^cam[-_ ]?\d+/i.test(name)) return { title: name.toUpperCase().replace(/[ _]/g, "-"), subtitle: "" };
  if (/^cam[-_ ]?\d+/i.test(camera.id)) return { title: camera.id.toUpperCase().replace(/[ _]/g, "-"), subtitle: name };
  return { title: name || "카메라", subtitle: "" };
}

/** @param {import("./types").Camera[]} cameras @param {string} id */
export function cameraTitle(cameras, id) {
  const camera = cameras.find((item) => item.id === id);
  return camera ? cameraLabel(camera).title : "알 수 없는 카메라";
}

/** @param {import("./types").Camera[]} cameras @param {string[]} requested @param {number} [limit] */
export function resolveCameraSelection(cameras, requested, limit = cameraLimit) {
  const valid = [...new Set(requested)].filter((id) => cameras.some((camera) => camera.id === id)).slice(0, limit);
  return valid.length ? valid : cameras.slice(0, limit).map((camera) => camera.id);
}

/** @param {import("./types").Camera[]} cameras @param {string[]} requested */
export function resolveFullCameraSelection(cameras, requested) {
  const selected = resolveCameraSelection(cameras, requested, cameraLimit);
  if (cameras.length !== cameraLimit || selected.length !== cameraLimit - 1 || !requested.length) return selected;
  return [...selected, ...cameras.map(({ id }) => id).filter((id) => !selected.includes(id))];
}
