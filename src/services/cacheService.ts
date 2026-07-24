import type { PythonHelper } from '../backend/pythonHelper'
import type { LocalModel, TopInfo } from '../shared/protocol'

/** Thin wrapper over the Python helper for the local model cache. */
export class CacheService {
  constructor(private readonly helper: PythonHelper) {}

  list(): Promise<LocalModel[]> {
    return this.helper.scan()
  }

  delete(repo: string): Promise<{ freedBytes: number }> {
    return this.helper.delete(repo)
  }

  top(): Promise<TopInfo> {
    return this.helper.top()
  }

  archSupported(modelType: string): Promise<boolean> {
    return this.helper.archSupported(modelType)
  }
}
