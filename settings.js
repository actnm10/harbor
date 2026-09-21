import { HttpError } from './lib.js';

const maxima = { maxUploadBytes: 1024 ** 4, maxStorageBytes: 1024 ** 5, maxConcurrentUploads: 64, sessionHours: 720, trashRetentionDays: 365 };
const keys = [...Object.keys(maxima), 'activeStorageId'];

export function createSettingsManager(db, config, storage, getUsage) {
  function validate(value) {
    for (const [key, maximum] of Object.entries(maxima)) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum) throw new HttpError(400, `${key} must be an integer between 1 and ${maximum}.`);
    }
    if (typeof value.activeStorageId !== 'string' || !db.prepare('SELECT id FROM storage_locations WHERE id=?').get(value.activeStorageId)) {
      throw new HttpError(400, 'Choose an existing storage location.');
    }
    storage.locationPath(value.activeStorageId);
    return value;
  }
  const saved = db.prepare("SELECT value FROM app_meta WHERE key='settings'").get();
  let current = validate(saved ? { trashRetentionDays: config.trashRetentionDays, ...JSON.parse(saved.value) } : {
    maxUploadBytes: config.maxUploadBytes, maxStorageBytes: config.maxStorageBytes,
    maxConcurrentUploads: config.maxConcurrentUploads, sessionHours: config.sessionHours,
    activeStorageId: 'original', trashRetentionDays: config.trashRetentionDays,
  });
  function write(value) { db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('settings',?)").run(JSON.stringify(value)); }
  function apply(value) { current = value; for (const key of keys) config[key] = value[key]; }
  if (!saved || !Object.hasOwn(JSON.parse(saved.value), 'trashRetentionDays')) write(current);
  apply(current);

  function snapshot() {
    const usage = getUsage();
    return { settings: { ...current }, storage: { root: storage.root, locations: storage.locations(),
      usedBytes: usage.usedBytes, reservedBytes: usage.reservedBytes }, deployment: { dataDir: config.dataDir } };
  }
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !keys.includes(key))) {
      throw new HttpError(400, 'Provide only supported settings fields.');
    }
    const next = validate({ ...current, ...patch });
    const usage = getUsage();
    if (next.maxStorageBytes < usage.usedBytes + usage.reservedBytes) throw new HttpError(409, 'The storage quota cannot be smaller than saved files and active upload reservations.');
    db.exec('BEGIN IMMEDIATE');
    try { write(next); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    apply(next);
    return snapshot();
  }
  function addStorage(name) {
    let next;
    storage.addLocation(name, id => { next = { ...current, activeStorageId: id }; write(next); });
    apply(next);
    return snapshot();
  }
  return { snapshot, update, addStorage };
}
