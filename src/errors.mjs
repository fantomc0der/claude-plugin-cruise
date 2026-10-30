export class CliError extends Error {
  constructor(code, message, { hint, exitCode = 1, data } = {}) {
    super(message)
    this.code = code
    this.hint = hint
    this.exitCode = exitCode
    this.data = data
  }

  toJSON() {
    const error = { code: this.code, message: this.message }
    if (this.hint) error.hint = this.hint
    if (this.data) error.data = this.data
    return { error }
  }
}

export const usage = (message, hint) => new CliError('usage', message, { hint, exitCode: 2 })
