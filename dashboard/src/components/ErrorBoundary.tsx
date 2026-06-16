import { Component, type ReactNode, type ErrorInfo } from 'react';
import { WarningCircle, ArrowClockwise } from '@phosphor-icons/react';
import { Button } from './ui/button';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-8 bg-background text-foreground">
          <div className="flex flex-col items-center text-center max-w-sm w-full">
            <div className="w-16 h-16 rounded-full bg-whatsapp-green/15 flex items-center justify-center mb-6">
              <WarningCircle size={32} className="text-whatsapp-green" />
            </div>

            <h1 className="text-[28px] font-light text-foreground/80 mb-2">
              {i18n.t('errorBoundary.title')}
            </h1>

            <p className="text-[14px] leading-relaxed text-muted-foreground mb-8 max-w-md">
              {i18n.t('errorBoundary.description')}
            </p>

            <Button
              onClick={this.handleReload}
              className="rounded-full bg-whatsapp-green hover:bg-whatsapp-green/90 text-white h-11 px-8 text-[15px]"
            >
              <ArrowClockwise size={18} weight="bold" />
              {i18n.t('errorBoundary.reload')}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
