#!/usr/bin/env node
import { main } from './cli-program'

export * from './cli-program'

if (require.main === module) {
  void main()
}
