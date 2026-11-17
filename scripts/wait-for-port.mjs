// Wait until a TCP port accepts connections: node scripts/wait-for-port.mjs 3143 [timeoutSeconds]
import { connect } from 'node:net'

const port = Number(process.argv[2])
const deadline = Date.now() + Number(process.argv[3] ?? 60) * 1000

const tryOnce = () =>
  new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => (s.end(), resolve(true)))
    s.once('error', () => resolve(false))
  })

while (!(await tryOnce())) {
  if (Date.now() > deadline) {
    console.error(`Port ${port} did not open in time`)
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 500))
}
// GreenMail accepts connections slightly before it accepts logins.
await new Promise((r) => setTimeout(r, 1500))
