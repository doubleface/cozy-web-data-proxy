import * as Comlink from 'comlink'

import CozyClient, { QueryDefinition, StackLink } from 'cozy-client'
import {
  Mutation,
  MutationOptions,
  QueryOptions
} from 'cozy-client/types/types'
import { SearchEngine } from 'cozy-dataproxy-lib'
import flag from 'cozy-flags'
import Minilog from 'cozy-minilog'
import PouchLink from 'cozy-pouch-link'

import {
  FILES_DOCTYPE,
  CONTACTS_DOCTYPE,
  APPS_DOCTYPE,
  ACCOUNTS_DOCTYPE,
  KONNECTORS_DOCTYPE,
  TRIGGERS_DOCTYPE,
  SETTINGS_DOCTYPE,
  SHARED_DRIVE_FILE_DOCTYPE,
  REPLICATION_DEBOUNCE,
  REPLICATION_DEBOUNCE_MAX_DELAY
} from '@/consts'
import {
  ClientData,
  DataProxyWorker,
  DataProxyWorkerPartialState,
  SearchOptions
} from '@/dataproxy/common/DataProxyInterface'
import { queryIsTrustedDevice } from '@/dataproxy/worker/data'
import {
  platformWorker,
  searchEngineStorage
} from '@/dataproxy/worker/platformWorker'
import schema from '@/doctypes'
import { getPouchLink } from '@/helpers/client'

const log = Minilog('👷‍♂️ [DataProxy worker]')
Minilog.enable()

let client: CozyClient | undefined = undefined
let searchEngine: SearchEngine

const broadcastChannel = new BroadcastChannel('DATA_PROXY_BROADCAST_CHANANEL')

const dataProxy: DataProxyWorker = {
  setup: async (
    clientData: ClientData,
    options: { sharedDriveIds: string[] } = { sharedDriveIds: [] } as {
      sharedDriveIds: string[]
    }
  ) => {
    log.debug('Received data for setting up client')
    if (client) return
    updateState()

    const pouchLinkOptions = {
      doctypes: [
        FILES_DOCTYPE,
        CONTACTS_DOCTYPE,
        APPS_DOCTYPE,
        ACCOUNTS_DOCTYPE,
        TRIGGERS_DOCTYPE,
        KONNECTORS_DOCTYPE,
        SETTINGS_DOCTYPE
      ],
      readOnly: true,
      initialSync: true,
      periodicSync: false,
      syncDebounceDelayInMs: REPLICATION_DEBOUNCE,
      syncDebounceMaxDelayInMs: REPLICATION_DEBOUNCE_MAX_DELAY,
      platform: { ...platformWorker },
      pouch: {
        options: {
          adapter: 'indexeddb'
        }
      },
      doctypesReplicationOptions: {
        [FILES_DOCTYPE]: {
          strategy: 'fromRemote'
        },
        [CONTACTS_DOCTYPE]: {
          strategy: 'fromRemote'
        },
        [APPS_DOCTYPE]: {
          strategy: 'fromRemote'
        },
        [ACCOUNTS_DOCTYPE]: {
          strategy: 'fromRemote'
        },
        [KONNECTORS_DOCTYPE]: {
          strategy: 'fromRemote'
        },
        [TRIGGERS_DOCTYPE]: {
          strategy: 'fromRemote'
        },
        [SETTINGS_DOCTYPE]: {
          strategy: 'fromRemote'
        }
      }
    }

    if (options?.sharedDriveIds?.length > 0) {
      pouchLinkOptions.doctypes.push(
        ...options?.sharedDriveIds?.map(
          id => `${SHARED_DRIVE_FILE_DOCTYPE}-${id}`
        )
      )
      pouchLinkOptions.doctypesReplicationOptions = {
        ...pouchLinkOptions.doctypesReplicationOptions,
        ...Object.fromEntries(
          options?.sharedDriveIds?.map(id => [
            `${SHARED_DRIVE_FILE_DOCTYPE}-${id}`,
            { strategy: 'fromRemote', driveId: id }
          ])
        )
      }
    }

    client = new CozyClient({
      uri: clientData.uri,
      token: clientData.token,
      appMetadata: {
        slug: 'cozy-data-proxy',
        version: '1'
      },
      schema,
      disableStoreForQueries: true
    })

    // If the device is not trusted, we do not want to store any private data in Pouch
    // So use the PouchLink only if the user declared a trustful device for the given session
    const isTrustedDevice = await queryIsTrustedDevice(client)
    // TODO: we should add the possibility to disable the pouchlink with a flag
    const links =
      isTrustedDevice && !clientData.useRemoteData
        ? [new PouchLink(pouchLinkOptions), new StackLink()]
        : [new StackLink()]

    await client.setLinks(links)
    client.instanceOptions = clientData.instanceOptions
    client.capabilities = clientData.capabilities
    client.registerPlugin(flag.plugin)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    flag.enable(clientData.instanceOptions?.flags)

    searchEngine = new SearchEngine(client, searchEngineStorage)

    log.debug('Setup done')
    updateState()
  },

  search: (query: string, options: SearchOptions | undefined) => {
    if (!client) {
      throw new Error(
        'Client is required to execute a search, please initialize CozyClient'
      )
    }
    if (!searchEngine) {
      throw new Error('SearchEngine is not initialized')
    }
    const startSearchTime = performance.now()
    const results = searchEngine.search(query, options)
    const endSearchTime = performance.now()
    log.debug(`Search took ${endSearchTime - startSearchTime} ms`)
    return results
  },

  requestLink: async (
    operation: QueryDefinition | Mutation,
    options?: QueryOptions | MutationOptions | undefined
  ): Promise<unknown> => {
    if (!client) {
      throw new Error(
        'Client is required to request, please initialize CozyClient'
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (operation.mutationType) {
      return client.requestMutation(operation, options)
    }
    const queryRes = (await client.requestQuery(
      operation as QueryDefinition,
      options as QueryOptions
    )) as unknown
    return queryRes
  },

  forceSyncPouch: () => {
    if (!client) {
      throw new Error(
        'Client is required to execute a forceSyncPouch, please initialize CozyClient'
      )
    }
    const pouchLink = getPouchLink(client)
    if (pouchLink) {
      pouchLink.startReplication()
    }
  },

  reconnectRealtime: () => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
    const realtime = client?.plugins?.realtime
    if (realtime) {
      realtime.reconnect()
      dataProxy.forceSyncPouch()
      searchEngine.init() // Init again to refresh indexes
    }
  },

  addSharedDrive: async (driveId: string) => {
    log.debug(`Worker: Adding shared drive ${driveId}`)
    if (!client) {
      throw new Error('Client is required to add a shared drive')
    }
    const pouchLink = getPouchLink(client)
    if (pouchLink) {
      const doctype = `${SHARED_DRIVE_FILE_DOCTYPE}-${driveId}`
      const options = { strategy: 'fromRemote', driveId }
      if (pouchLink.addDoctype) {
        pouchLink.addDoctype(doctype, options)
        pouchLink.startReplicationWithDebounce()
      }
    }

    if (!searchEngine) {
      throw new Error('SearchEngine is not initialized')
    }

    searchEngine.addSharedDrive(driveId)
  },

  removeSharedDrive: (driveId: string) => {
    log.debug(`Worker: Removing shared drive ${driveId}`)
    if (!client) {
      throw new Error('Client is required to remove a shared drive')
    }
    const pouchLink = getPouchLink(client)
    if (pouchLink) {
      const doctype = `${SHARED_DRIVE_FILE_DOCTYPE}-${driveId}`
      pouchLink.removeDoctype(doctype)
    }

    if (!searchEngine) {
      throw new Error('SearchEngine is not initialized')
    }

    searchEngine.removeSharedDrive(driveId)
  }
}

const updateState = (): void => {
  const state = {} as DataProxyWorkerPartialState

  if (client && searchEngine && searchEngine.searchIndexes) {
    state.status = 'Ready'
    state.indexLength = Object.entries(searchEngine.searchIndexes).map(
      ([doctype, searchIndex]) => ({
        doctype,
        // @ts-expect-error index.store is not TS typed
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        count: Object.keys(searchIndex.index.store).length
      })
    )
    broadcastChannel.postMessage(state)
    return
  }

  if (client) {
    state.status = 'Client set'
    broadcastChannel.postMessage(state)
    return
  }

  state.status = 'Waiting configuration'
  broadcastChannel.postMessage(state)
}

if (
  typeof SharedWorkerGlobalScope !== 'undefined' &&
  self instanceof SharedWorkerGlobalScope
) {
  onconnect = (e: MessageEvent): void => {
    const port = e.ports[0]

    Comlink.expose(dataProxy, port)
    updateState()
  }
} else if (self instanceof DedicatedWorkerGlobalScope) {
  Comlink.expose(dataProxy)
  updateState()
} else {
  throw new Error('Worker context not available, abort.')
}
