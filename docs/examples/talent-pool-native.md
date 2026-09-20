# Central de Recrutamento nativa

O módulo interno **Central de Recrutamento** mantém cadastros, formulários, agenda e atendimento humano no banco de dados da própria aplicação. A rota técnica `talent-pool` é preservada por compatibilidade. Ele não depende de Google Sheets, Google Drive nem credenciais OAuth.

## Ativação

1. Pare a aplicação e execute `npm run migration:run` (ou inicie a versão compilada, quando as migrações automáticas estiverem habilitadas).
2. Reinicie o OpenWA.
3. No dashboard, abra **Central de Recrutamento**, selecione a sessão e acesse **Configurações** com uma chave de administrador.
4. Crie ou escolha um fluxo e configure campos, prazos e mensagens automáticas.
5. Publique ao menos um fluxo para ativar a Central de Recrutamento na sessão.
6. Desative o plugin legado `talent-pool-rh` para que ele não mantenha rotinas paralelas nem continue usando Google OAuth.

O módulo nasce desativado em cada sessão. Quando ativado, ele assume as conversas privadas daquela sessão antes dos plugins de resposta. Grupos, status e mensagens enviadas pela própria conta não iniciam cadastro.

## Estados e persistência

- O rascunho de cadastro e as alterações pendentes ficam em `talent_flow_sessions`.
- O cadastro válido fica isolado em `talent_candidates` e nunca é apagado por timeout de menu ou atualização.
- Chamados e prazos ficam em `talent_tickets`; mudanças relevantes ficam em `talent_ticket_events`.
- Mensagens processadas ficam em `talent_processed_messages`, cuja chave única evita reprocessamento.
- Expirações limpam o rascunho e preservam somente o estado terminal `CADASTRO_EXPIRADO` ou `CHAT_ENCERRADO`.
- A mensagem seguinte reutiliza apenas a identidade do contato e começa um fluxo novo; nenhum dado parcial expirado é recuperado.

Durante `EM_ATENDIMENTO_HUMANO` e `AVISO_DE_INATIVIDADE`, mensagens recebidas apenas renovam a atividade do chamado. O bot não interpreta nem responde. Mensagens enviadas pelo atendente no chat e a ação **Manter aberto** também reiniciam o prazo.

## Permissões

- `ADMIN`: altera campos, mensagens e prazos, além de consultar e operar chamados.
- `OPERATOR`: consulta candidatos e histórico, mantém chamados abertos e os encerra manualmente.
- `VIEWER`: não recebe acesso à Central de Recrutamento.

O currículo é armazenado pelo mecanismo de mídia já existente no histórico de mensagens. A tela do candidato oferece o download do PDF quando a mídia foi arquivada ou mantida em linha pela configuração da aplicação.
