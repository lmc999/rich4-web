import { describe, expect, it } from 'vitest';
import { clientIp, isTrustedProxy } from '../../src/net/io';

function sock(address: string, xff?: string | string[]) {
  return {
    handshake: { address, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } },
  } as unknown as Parameters<typeof clientIp>[0];
}

describe('clientIp（design/net.md §10.3）', () => {
  it('可信代理网段：本机、私有网段、IPv4-mapped', () => {
    for (const a of ['127.0.0.1', '::1', '10.1.2.3', '172.18.0.5', '192.168.1.1', '::ffff:127.0.0.1', 'fd00::1']) {
      expect(isTrustedProxy(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '2001:db8::1', 'not-an-ip', '']) expect(isTrustedProxy(a), a).toBe(false);
  });

  it('TRUST_PROXY 关闭：一律用直连地址', () => {
    expect(clientIp(sock('127.0.0.1', '9.9.9.9'), false)).toBe('127.0.0.1');
  });

  it('直连对端不是可信代理：忽略客户端自带的 X-Forwarded-For', () => {
    expect(clientIp(sock('203.0.113.7', '1.2.3.4'), true)).toBe('203.0.113.7');
    expect(clientIp(sock('::ffff:203.0.113.7', '1.2.3.4'), true)).toBe('203.0.113.7');
  });

  it('经本机反代：取最右边的不可信地址（最左段可被伪造）', () => {
    // nginx $proxy_add_x_forwarded_for：客户端伪造 1.2.3.4，真实对端 203.0.113.7 被追加在最右
    expect(clientIp(sock('127.0.0.1', '1.2.3.4, 203.0.113.7'), true)).toBe('203.0.113.7');
    // 多级可信代理
    expect(clientIp(sock('172.18.0.2', '203.0.113.7, 10.0.0.5'), true)).toBe('203.0.113.7');
    expect(clientIp(sock('::ffff:172.18.0.2', ['203.0.113.9']), true)).toBe('203.0.113.9');
    // 全是内网地址（局域网部署）：取最左
    expect(clientIp(sock('127.0.0.1', '192.168.1.20'), true)).toBe('192.168.1.20');
    // 没有或无效的 XFF：用直连地址
    expect(clientIp(sock('127.0.0.1'), true)).toBe('127.0.0.1');
    expect(clientIp(sock('127.0.0.1', 'garbage'), true)).toBe('127.0.0.1');
  });
});
