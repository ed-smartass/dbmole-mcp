import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TestCerts = {
    dir: string
    ca: string
    caPath: string
    certPath: string
    keyPath: string
}

// A throwaway CA plus a server certificate for `dnsName` (CN and SAN), made with
// the openssl CLI: node:crypto cannot issue X.509 certificates.
export const makeCerts = (dnsName: string): TestCerts => {
    const dir = mkdtempSync(join(tmpdir(), 'dbmole-tls-'))
    const openssl = (command: string) => {
        execFileSync('openssl', command.split(' '), { cwd: dir, stdio: 'pipe' })
    }
    openssl(
        'req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=dbmole-test-ca ' +
            '-keyout ca.key -out ca.crt'
    )
    openssl(
        'req -newkey rsa:2048 -nodes -subj /CN=' + dnsName + ' -keyout server.key -out server.csr'
    )
    writeFileSync(join(dir, 'san.cnf'), 'subjectAltName=DNS:' + dnsName + '\n')
    openssl(
        'x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 ' +
            '-extfile san.cnf -out server.crt'
    )
    const caPath = join(dir, 'ca.crt')
    return {
        dir,
        ca: readFileSync(caPath, 'utf8'),
        caPath,
        certPath: join(dir, 'server.crt'),
        keyPath: join(dir, 'server.key')
    }
}

// mysql:8.4 generates its own CA and server certificate on first start.
export const mysqlCa = async (container: {
    exec: (command: string[]) => Promise<{ stdout: string }>
}): Promise<string> => (await container.exec(['cat', '/var/lib/mysql/ca.pem'])).stdout
