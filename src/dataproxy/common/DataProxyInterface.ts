import type { InstanceOptions, QueryDefinition } from 'cozy-client'
import type {
  ClientCapabilities,
  Mutation,
  MutationOptions,
  QueryOptions
} from 'cozy-client/types/types'

// TODO: Should be imported from cozy-dataproxy-lib
export interface SearchOptions {
  doctypes: string[]
}

export interface DataProxyWorker {
  search: (query: string, options: SearchOptions) => unknown
  setup: (
    clientData: ClientData,
    options?: { sharedDriveIds: string[] }
  ) => Promise<void>
  forceSyncPouch: () => void
  requestLink: (
    definition: QueryDefinition | Mutation,
    options?: QueryOptions | MutationOptions
  ) => Promise<unknown>
  reconnectRealtime: () => void
  addSharedDrive: (driveId: string) => void
  removeSharedDrive: (driveId: string) => void
}

export interface DataProxyWorkerPartialState {
  status: string
  tabCount: number
  indexLength?: IndexLength[]
}
export interface DataProxyWorkerState extends DataProxyWorkerPartialState {
  tabCount: number
}

export interface DataProxyWorkerContext {
  worker: DataProxyWorker
  workerState: DataProxyWorkerState
}

interface IndexLength {
  doctype: string
  count: number
}

export interface ClientData {
  uri: string
  token: string
  instanceOptions: InstanceOptions
  capabilities: ClientCapabilities
  useRemoteData: boolean
}
