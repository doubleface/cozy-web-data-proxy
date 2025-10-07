import * as Comlink from 'comlink'
import React, { useState, useEffect, ReactNode } from 'react'

import { useClient } from 'cozy-client'
import flag from 'cozy-flags'
import Minilog from 'cozy-minilog'

import {
  DataProxyWorker,
  DataProxyWorkerContext,
  DataProxyWorkerPartialState
} from '@/dataproxy/common/DataProxyInterface'
import { TabCountSync } from '@/dataproxy/common/TabCountSync'
import { removeStaleLocalData } from '@/dataproxy/worker/data'

const log = Minilog('👷‍♂️ [SharedWorkerProvider]')

// Event payload received from cozy realtime for io.cozy.files
type FilesRealtimeEvent = {
  dir_id: string
  class: string
  referenced_by?: Array<{ id?: string }>
}

function isFilesRealtimeEvent(value: unknown): value is FilesRealtimeEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.dir_id === 'string' &&
    typeof v.class === 'string' &&
    (v.referenced_by === undefined || Array.isArray(v.referenced_by))
  )
}

interface Realtime {
  subscribe: (
    event: 'created' | 'deleted' | 'updated',
    doctype: string,
    handler: (event: unknown) => void
  ) => void
  unsubscribe: (
    event: 'created' | 'deleted' | 'updated',
    doctype: string,
    handler: (event: unknown) => void
  ) => void
}

function hasRealtimePlugin(
  plugins: unknown
): plugins is { realtime: Realtime } {
  return (
    !!plugins &&
    typeof plugins === 'object' &&
    'realtime' in (plugins as Record<string, unknown>) &&
    typeof (plugins as { realtime?: unknown }).realtime === 'object'
  )
}

export const SharedWorkerContext = React.createContext<
  DataProxyWorkerContext | undefined
>(undefined)

interface SharedWorkerProviderProps {
  children: ReactNode
}

let broadcastChannel: BroadcastChannel
if (typeof BroadcastChannel === 'function') {
  broadcastChannel = new BroadcastChannel('DATA_PROXY_BROADCAST_CHANANEL')
}
const tcs = new TabCountSync()
window.addEventListener('unload', () => tcs.close())

export const SharedWorkerProvider = React.memo(
  ({ children }: SharedWorkerProviderProps) => {
    const [worker, setWorker] = useState<DataProxyWorker | undefined>()
    const [workerState, setWorkerState] = useState<DataProxyWorkerPartialState>(
      {
        status: 'not initialized',
        tabCount: 0
      }
    )
    const [tabCount, setTabCount] = useState(0)
    const client = useClient()

    useEffect(() => {
      if (!client || !flag('drive.shared-drive.enabled')) return

      if (!hasRealtimePlugin(client.plugins)) {
        throw new Error(
          'You must include the realtime plugin to use RealTimeQueries'
        )
      }
      const realtime = client.plugins.realtime

      if (!realtime) {
        throw new Error(
          'You must include the realtime plugin to use RealTimeQueries'
        )
      }

      const handleFileCreated = (event: unknown): void => {
        if (!isFilesRealtimeEvent(event)) return
        if (
          event.dir_id === 'io.cozy.files.shared-drives-dir' &&
          event.class === 'shortcut'
        ) {
          const driveId = event?.referenced_by?.[0]?.id
          if (driveId) {
            log.info(`Shared drive ${driveId} created`)
            worker?.addSharedDrive(driveId)
          }
        }
      }
      const handleFileDeleted = (event: unknown): void => {
        if (!isFilesRealtimeEvent(event)) return
        if (
          event.dir_id === 'io.cozy.files.shared-drives-dir' &&
          event.class === 'shortcut'
        ) {
          const driveId = event?.referenced_by?.[0]?.id
          if (driveId) {
            log.info(`Shared drive ${driveId} deleted`)
            worker?.removeSharedDrive(driveId)
          }
        }
      }
      realtime.subscribe('created', 'io.cozy.files', handleFileCreated)
      realtime.subscribe('deleted', 'io.cozy.files', handleFileDeleted)
      return (): void => {
        realtime.unsubscribe('created', 'io.cozy.files', handleFileCreated)
        realtime.unsubscribe('deleted', 'io.cozy.files', handleFileDeleted)
      }
    }, [client, worker])

    useEffect(() => {
      if (!client) return

      const doAsync = async (): Promise<void> => {
        // Cleanup any remaining local data
        await removeStaleLocalData()

        let sharedDriveIds: string[] = []

        // Fetch shared drives only if the feature is enabled
        if (flag('drive.shared-drive.enabled')) {
          const { data: sharedDrives } = await client
            .collection('io.cozy.sharings')
            .fetchSharedDrives()

          sharedDriveIds = sharedDrives.map((drive: { id: string }) => drive.id)
        }

        log.debug('Init SharedWorker')

        let obj: Comlink.Remote<DataProxyWorker>
        let useRemoteData: boolean = false
        try {
          const workerInst = new SharedWorker(
            new URL('./worker.ts', import.meta.url),
            {
              name: 'dataproxy-worker'
            }
          )
          obj = Comlink.wrap<DataProxyWorker>(workerInst.port)
        } catch (e) {
          // SharedWorker is not available in all contexts, e.g. old desktop browsers
          // or some mobile browsers. So we fallback to web worker and ask the dataproxy
          // to use remote data rather than local.
          log.warn('SharedWorker is not available. Falling back to web Worker')
          const workerInst = new Worker(
            new URL('./worker.ts', import.meta.url),
            {
              name: 'dataproxy-worker'
            }
          )
          obj = Comlink.wrap<DataProxyWorker>(workerInst)
          useRemoteData = true
        }

        log.debug('Provide CozyClient data to Worker')
        const { uri, token } = client.getStackClient()

        await obj.setup(
          {
            uri,
            token: token.token,
            instanceOptions: client.instanceOptions,
            capabilities: client.capabilities,
            useRemoteData
          },
          { sharedDriveIds } as { sharedDriveIds: string[] }
        )
        setWorker((): Comlink.Remote<DataProxyWorker> => obj)
      }

      doAsync()
    }, [client])

    useEffect(() => {
      broadcastChannel.addEventListener('message', (event: MessageEvent) => {
        setWorkerState(event.data as DataProxyWorkerPartialState)
      })
    }, [])

    useEffect(() => {
      tcs.subscribe((count: number) => {
        setTabCount(count)
      })
    }, [])

    if (!worker) return undefined

    const value = {
      worker,
      workerState: {
        ...workerState,
        tabCount
      }
    }

    return (
      <SharedWorkerContext.Provider value={value}>
        {children}
      </SharedWorkerContext.Provider>
    )
  }
)

SharedWorkerProvider.displayName = 'SharedWorkerProvider'
