import CozyClient from 'cozy-client'
import Minilog from 'cozy-minilog'

import { LOCALSTORAGE_KEY_DELETING_DATA } from '@/consts'
const log = Minilog('👷‍♂️ [Worker utils]')

interface SessionInfo {
  last_seen: string
  long_run: boolean
}

interface SessionResponse {
  data: {
    attributes: SessionInfo
  }
}

export const queryIsTrustedDevice = async (
  client: CozyClient
): Promise<boolean> => {
  const resp: SessionResponse = await client
    .getStackClient()
    .fetchJSON('GET', '/settings/sessions/current')

  const isLongRun = resp?.data?.attributes?.long_run
  const isDefined = isLongRun !== undefined

  if (!isDefined) {
    return true // special case for twake instances with linagora SSO
  } else {
    return !!isLongRun
  }
}

const deleteDatabases = async (): Promise<void> => {
  if (typeof window.indexedDB?.databases === 'function') {
    const databases = await window.indexedDB.databases()
    // Remove all indexedDB databases
    for (const db of databases) {
      if (db.name) {
        window.indexedDB.deleteDatabase(db.name)
        log.info('Deleted indexedDB database : ', db.name)
      }
    }
  }
}

export const removeStaleLocalData = async (): Promise<void> => {
  // Check flag existence proving the reset process was incomplete
  try {
    const hasStaleData = localStorage.getItem(LOCALSTORAGE_KEY_DELETING_DATA)
    if (hasStaleData) {
      log.info('Found stale data: remove it')
      await deleteDatabases()
      localStorage.removeItem(LOCALSTORAGE_KEY_DELETING_DATA)
    }
  } catch (e) {
    log.error(e)
  }
  return
}
