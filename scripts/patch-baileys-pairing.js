/**
 * rc14 backports of WhiskeySockets/Baileys #2749 and #2765, with one adaptation.
 * Pre-login notifications have no creds.me; ACKs must still be sent. When WA
 * retires unpaired registration material, rotate only its advertisement secret,
 * persist it through creds.update and re-render the current QR without spending
 * another ref. Registered/pairing-code sessions and malformed nodes stay intact.
 * Adaptation: once creds.me is set (a pairing code was requested, or the device
 * is registered) the QR timer stops. Upstream keeps it running, so there running
 * out of refs ends the socket with 'QR refs attempts ended'; here it never does.
 * Sources: https://github.com/WhiskeySockets/Baileys/pull/2749 (3868667)
 *          https://github.com/WhiskeySockets/Baileys/pull/2765 (4f263f0)
 * Neither PR is merged. Retire after an upstream release includes both fixes.
 * All shapes are checked before writing. Unknown or partially patched trees fail.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { writeFilesAtomic } = require('./atomic-write');
const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const QR_FIND = String.raw`    // QR gen
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        const iq = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'result',
                id: stanza.attrs.id
            }
        };
        await sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const advB64 = creds.advSecretKey;
        let qrMs = qrTimeout || 60000; // time to let a QR live
        const genPairQR = () => {
            if (!ws.isOpen) {
                return;
            }
            const refNode = refNodes.shift();
            if (!refNode) {
                void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));
                return;
            }
            const ref = refNode.content.toString('utf-8');
            const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);
            ev.emit('connection.update', { qr });
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000; // shorter subsequent qrs
        };
        genPairQR();
    });
`;
const QR_REPLACE = String.raw`    // OpenWA: Baileys #2765 companion registration refresh (rc14 backport).
    let refreshPairingQR;
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        await sendNode({tag: 'iq', attrs: {to: S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id}});
        const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        let currentRef;
        const renderQR = () => {
            if (!ws.isOpen || currentRef === undefined || creds.me) return;
            // Read the secret on every render: the server can retire it mid-flow.
            const qr = buildPairingQRData(currentRef, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);
            ev.emit('connection.update', {qr});
        };
        refreshPairingQR = renderQR;
        let qrMs = qrTimeout || 60000;
        const genPairQR = () => {
            if (!ws.isOpen || creds.me) return;
            const refNode = refNodes.shift();
            if (!refNode) {
                void end(new Boom('QR refs attempts ended', {statusCode: DisconnectReason.timedOut}));
                return;
            }
            currentRef = refNode.content.toString('utf-8');
            renderQR();
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000;
        };
        clearTimeout(qrTimer);
        genPairQR();
    });
    ws.on('CB:notification,type:companion_reg_refresh', node => {
        if (creds.me || !ws.isOpen) return;
        if (!['companion_reg_refresh', 'pair-device-rotate-qr'].some(tag => getBinaryNodeChild(node, tag))) return;
        creds.advSecretKey = randomBytes(32).toString('base64');
        ev.emit('creds.update', {advSecretKey: creds.advSecretKey});
        logger.info({}, 'companion registration refreshed');
        // Re-render the same ref. Do not consume the pool or reset its timer.
        refreshPairingQR?.();
    });
`;
const ACK_FIND = 'buildAckStanza(node, errorCode, authState.creds.me.id)';
const ACK_REPLACE = 'buildAckStanza(node, errorCode, authState.creds.me?.id)';
const GROUPS = [
  ['lib/Socket/socket.js', QR_FIND, QR_REPLACE],
  ['lib/Socket/messages-recv.js', ACK_FIND, ACK_REPLACE],
];
function classify(dir) {
  const items = [];
  for (const [relative, find, replace] of GROUPS) {
    const file = path.join(dir, relative);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      error.partial = items.some(item => item.state === 'applied');
      throw error;
    }
    const replaced = source.split(replace).length - 1;
    const pristine = source.replace(replace, '').split(find).length - 1;
    const refreshHandlers = source.split("ws.on('CB:notification,type:companion_reg_refresh'").length - 1;
    const conflictingRefresh = relative === 'lib/Socket/socket.js' && refreshHandlers !== replaced;
    items.push({
      file,
      source,
      find,
      replace,
      state: conflictingRefresh
        ? 'unknown'
        : replaced === 1 && pristine === 0
          ? 'applied'
          : replaced === 0 && pristine === 1
            ? 'pristine'
            : 'unknown',
    });
  }
  return items;
}
function isApplied(dir = DEFAULT_BAILEYS) {
  try {
    return classify(dir).every(item => item.state === 'applied');
  } catch {
    return true;
  }
}
function applyPairingPatch(dir = DEFAULT_BAILEYS) {
  const items = classify(dir);
  if (items.every(item => item.state === 'applied')) return { skipped: true };
  if (!items.every(item => item.state === 'pristine')) {
    const error = Error(
      'Unknown or partially patched Baileys pairing shape; no files written. Re-evaluate upstream #2749/#2765.',
    );
    error.partial = items.some(item => item.state === 'applied');
    throw error;
  }
  // Both files are staged before the first is replaced, so a failed write leaves the tree as it was. Only
  // a rename that fails after the first one went through leaves half a patch, and is marked partial.
  writeFilesAtomic(items.map(item => [item.file, item.source.replace(item.find, item.replace)]));
  return { skipped: false };
}
function run(dir = DEFAULT_BAILEYS, bestEffort = process.argv.includes('--best-effort')) {
  try {
    const result = applyPairingPatch(dir);
    console.log(
      'patch-baileys-pairing: ' +
        (result.skipped ? 'already applied' : 'applied ACK and registration-refresh backports'),
    );
  } catch (error) {
    if (bestEffort && !error.partial) {
      console.warn('patch-baileys-pairing: skipped: ' + error.message);
      return 0;
    }
    console.error('patch-baileys-pairing: ' + error.message);
    return 1;
  }
  return 0;
}
if (require.main === module) process.exitCode = run();
module.exports = { applyPairingPatch, isApplied, run, QR_FIND, QR_REPLACE, ACK_FIND, ACK_REPLACE };
