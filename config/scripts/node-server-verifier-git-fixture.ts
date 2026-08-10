import { execFileSync } from 'node:child_process'

export function initializeNodeServerVerifierGitWorkspace(gitPath: string): void {
  execFileSync('git', ['init', gitPath], { stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      gitPath,
      '-c',
      'user.name=Orca Verifier',
      '-c',
      'user.email=verifier@orca.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Initial verifier commit'
    ],
    { stdio: 'ignore' }
  )
}
