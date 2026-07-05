import { memo, type ReactNode } from 'react';
import Linkify from 'linkify-react';
import { parseMessageBody, type MessageNode } from '../../utils/messageFormatter';

interface Props {
  text: string;
  className?: string;
  enableLinks?: boolean;
}

const linkifyOptions = {
  target: '_blank',
  rel: 'noopener noreferrer',
  defaultProtocol: 'https',
  ignoreTags: ['code', 'pre'],
  attributes: {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  },
};

function renderNode(node: MessageNode, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return <span key={key}>{node.value}</span>;
    case 'bold':
      return <strong key={key}>{node.children.map(renderNode)}</strong>;
    case 'italic':
      return <em key={key}>{node.children.map(renderNode)}</em>;
    case 'strike':
      return <s key={key}>{node.children.map(renderNode)}</s>;
    case 'code':
      return <code key={key}>{node.value}</code>;
    case 'codeblock':
      return <pre key={key}><code>{node.value}</code></pre>;
  }
}

function MessageBodyBase({ text, className, enableLinks = true }: Props) {
  const nodes = parseMessageBody(text);
  const rendered = <>{nodes.map(renderNode)}</>;
  return (
    <div className={className}>
      {enableLinks ? <Linkify options={linkifyOptions}>{rendered}</Linkify> : rendered}
    </div>
  );
}

export default memo(MessageBodyBase);
