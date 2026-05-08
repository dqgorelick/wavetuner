// Reactive list of patches (built-ins + user patches), plus mutation
// helpers. Subscribes to cross-tab storage events so saves/deletes in
// another tab show up here too.

import { useCallback, useEffect, useState } from 'react';
import { BUILTIN_PATCHES } from '../patches/builtins';
import {
  listUserPatches,
  saveUserPatch,
  deleteUserPatch,
  renameUserPatch,
  subscribePatches,
  isStorageAvailable,
} from '../patches/storage';
import { capturePatch } from '../patches/apply';

export function usePatches() {
  const [userPatches, setUserPatches] = useState(() => listUserPatches());

  const refresh = useCallback(() => {
    setUserPatches(listUserPatches());
  }, []);

  useEffect(() => subscribePatches(refresh), [refresh]);

  const saveCurrent = useCallback((name) => {
    const patch = capturePatch({ name: name?.trim() || 'Untitled patch' });
    if (saveUserPatch(patch)) {
      refresh();
      return patch;
    }
    return null;
  }, [refresh]);

  const remove = useCallback((id) => {
    deleteUserPatch(id);
    refresh();
  }, [refresh]);

  const rename = useCallback((id, name) => {
    if (renameUserPatch(id, name?.trim() || 'Untitled patch')) refresh();
  }, [refresh]);

  return {
    builtins: BUILTIN_PATCHES,
    userPatches,
    saveCurrent,
    remove,
    rename,
    storageAvailable: isStorageAvailable(),
  };
}
