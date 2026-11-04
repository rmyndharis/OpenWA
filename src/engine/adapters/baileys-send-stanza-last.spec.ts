import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * mapSendRefusal reports a send that failed on a closed connection as one that sent nothing, which a client
 * may then retry. That is only true while the installed library writes the message stanza as the last
 * thing a send awaits: a later awaited socket step could fail on the same closed connection after the
 * message already went out, and the retry would deliver it twice. This reads the library as installed, so
 * an upgrade that awaits anything after the stanza fails here instead of duplicating messages.
 */
describe('Baileys sendMessage writes the message stanza last', () => {
  const file = path.join(__dirname, '../../../node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);

  /** Every node under `root` matching `match`, not descending into `skip`. */
  function collect<T extends ts.Node>(
    root: ts.Node,
    match: (node: ts.Node) => node is T,
    skip: (node: ts.Node) => boolean = () => false,
  ) {
    const found: T[] = [];
    const visit = (node: ts.Node): void => {
      if (match(node)) found.push(node);
      if (!skip(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return found;
  }

  /** The function a library binding names, as `const name = async () => ...` or `name: async () => ...`. */
  function named(name: string): ts.FunctionLikeDeclaration {
    const bindings = collect(
      source,
      (node): node is ts.VariableDeclaration | ts.PropertyAssignment =>
        (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
        node.name.getText(source) === name &&
        !!node.initializer &&
        isFunction(node.initializer),
    );
    expect(bindings).toHaveLength(1);
    return bindings[0].initializer as ts.FunctionLikeDeclaration;
  }

  /** Awaits that run in `fn` itself, not in a function it creates (a callback left running). */
  const ownAwaits = (fn: ts.Node): ts.AwaitExpression[] =>
    collect(fn, ts.isAwaitExpression, node => node !== fn && isFunction(node));

  /** Whether the statement awaiting `step` is followed by a return, so nothing after it in its function runs. */
  function returnsRightAfter(step: ts.AwaitExpression): boolean {
    const statement = step.parent;
    if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return false;
    const siblings = statement.parent.statements;
    const next = siblings[siblings.indexOf(statement) + 1];
    return !!next && ts.isReturnStatement(next) && !next.expression;
  }

  /**
   * Awaited steps that can run after `step`: later in the function running it (none when a bare return
   * follows it), then later in every function out to `outer`, which awaits the one before it.
   */
  function awaitedAfter(step: ts.AwaitExpression, outer: ts.Node): string[] {
    const later: string[] = [];
    let innermost = true;
    for (let node: ts.Node | undefined = step.parent; node; node = node.parent) {
      if (!isFunction(node)) continue;
      if (!(innermost && returnsRightAfter(step))) {
        for (const awaited of ownAwaits(node)) {
          if (awaited.getStart(source) > step.getEnd()) later.push(awaited.getText(source).slice(0, 80));
        }
      }
      innermost = false;
      if (node === outer) break;
    }
    return later;
  }

  const awaitsCall = (callee: string) => (node: ts.Node) =>
    ts.isAwaitExpression(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(source) === callee;

  it('awaits nothing in relayMessage once the stanza is written', () => {
    const relayMessage = named('relayMessage');
    const writes = collect(relayMessage, (node): node is ts.AwaitExpression => awaitsCall('sendNode')(node));

    // The newsletter branch and the regular one, each writing its stanza.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const write of writes) {
      expect((write.expression as ts.CallExpression).arguments.map(arg => arg.getText(source))).toEqual(['stanza']);
      expect(awaitedAfter(write, relayMessage)).toEqual([]);
    }
  });

  it('awaits nothing in sendMessage once relayMessage returns', () => {
    const sendMessage = named('sendMessage');
    const relays = collect(sendMessage, (node): node is ts.AwaitExpression => awaitsCall('relayMessage')(node));

    expect(relays).toHaveLength(1);
    expect(awaitedAfter(relays[0], sendMessage)).toEqual([]);
  });
});
