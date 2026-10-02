/**
 * Exact rc14 backports of WhiskeySockets/Baileys #2749 and #2765.
 * Pre-login notifications have no creds.me; ACKs must still be sent. When WA
 * retires unpaired registration material, rotate only its advertisement secret,
 * persist it through creds.update and re-render the current QR without spending
 * another ref. Registered/pairing-code sessions and malformed nodes stay intact.
 * Sources: https://github.com/WhiskeySockets/Baileys/pull/2749 (3868667)
 *          https://github.com/WhiskeySockets/Baileys/pull/2765 (4f263f0)
 * Neither PR is merged. Retire after an upstream release includes both fixes.
 * All shapes are checked before writing. Unknown or partially patched trees fail.
 */
'use strict';
const fs = require('fs');
const path = require('path');
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
  return GROUPS.map(([relative, find, replace]) => {
    const file = path.join(dir, relative),
      source = fs.readFileSync(file, 'utf8');
    const replaced = source.split(replace).length - 1;
    const pristine = source.replace(replace, '').split(find).length - 1;
    return {
      file,
      source,
      find,
      replace,
      state: replaced === 1 && pristine === 0 ? 'applied' : replaced === 0 && pristine === 1 ? 'pristine' : 'unknown',
    };
  });
}
function isApplied(dir = DEFAULT_BAILEYS) {
  try {
    return classify(dir).every(item => item.state === 'applied');
  } catch {
    return false;
  }
}
function applyPairingPatch(dir = DEFAULT_BAILEYS) {
  const items = classify(dir);
  if (items.every(item => item.state === 'applied')) return { skipped: true };
  if (!items.every(item => item.state === 'pristine')) {
    throw Error(
      'Unknown or partially patched Baileys pairing shape; no files written. Re-evaluate upstream #2749/#2765.',
    );
  }
  for (const item of items) fs.writeFileSync(item.file, item.source.replace(item.find, item.replace));
  return { skipped: false };
}
if (require.main === module) {
  try {
    const result = applyPairingPatch();
    console.log(
      'patch-baileys-pairing: ' +
        (result.skipped ? 'already applied' : 'applied ACK and registration-refresh backports'),
    );
  } catch (error) {
    console.error('patch-baileys-pairing: ' + error.message);
    process.exitCode = 1;
  }
}
module.exports = { applyPairingPatch, isApplied, QR_FIND, QR_REPLACE, ACK_FIND, ACK_REPLACE };
