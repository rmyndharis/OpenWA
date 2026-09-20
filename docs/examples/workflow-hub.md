# Central de Recrutamento

## Diagnóstico sem iniciar o WhatsApp

Para conferir banco, migrações, relacionamentos, agenda, chamados e mensagens pendentes sem iniciar
sessões nem enviar mensagens, execute:

```bash
npm run doctor:workflow
```

O comando é somente leitura. `ERRO` indica uma inconsistência que deve ser corrigida; `AVISO` indica
uma pendência operacional, como uma mensagem que será tentada quando o OpenWA voltar a funcionar.

## Menu configurável de cada fluxo

Depois que um cadastro é concluído, cada fluxo pode apresentar seu próprio menu. Na aba
**Configurações**, selecione o fluxo e use **Menu depois do cadastro** para:

- personalizar a mensagem de conclusão e o título;
- ativar ou ocultar consultar dados, atualizar dados, atendimento humano, encerrar e solicitar exclusão;
- alterar o texto e a ordem das ações.

Os números são recalculados automaticamente usando apenas as ações ativas. A configuração pertence
ao fluxo selecionado; portanto, fluxos diferentes podem ter menus diferentes.

## Editor visual da conversa

Na aba **Fluxos**, escolha um fluxo para abrir o **Diagrama da conversa**. O diagrama faz parte do
rascunho versionado e só altera a conversa no WhatsApp depois de salvar e publicar.

- Arraste os blocos para organizar a visão e use as alças laterais para criar conexões.
- Selecione uma conexão e clique em **Inserir mensagem** para enviar um texto entre duas perguntas.
- Selecione a conexão que sai de uma pergunta para definir uma condição, como “resposta igual a
  Sim”. Assim, cada resposta pode levar a perguntas e mensagens diferentes.
- Toda pergunta precisa ter um **Caminho padrão**. Ele é usado quando nenhuma condição combina.
- O botão **Organizar** reposiciona automaticamente o diagrama sem alterar a ordem da conversa.
- As perguntas continuam sendo configuradas no formulário detalhado abaixo do diagrama. Cada
  pergunta aparece uma vez no diagrama, mas seu campo de resposta pode ser reutilizado por caminhos
  que não acontecem juntos.

Fluxos antigos continuam funcionando na ordem tradicional. Ao editar e salvar um deles, o painel
cria automaticamente o diagrama linear equivalente, que então pode ser ramificado.

## Mensagens editáveis

Na aba **Configurações**, o menu inicial do setor e as mensagens de cada fluxo podem ser editados em
campos próprios. Os textos vazios usam o padrão do sistema. Variáveis entre chaves são substituídas
no envio, por exemplo: `{setor}`, `{fluxos}`, `{fluxo}`, `{resumo}`, `{data}`, `{hora}`, `{local}` e
`{minutos}`. O painel informa as variáveis disponíveis em cada mensagem e preserva um editor JSON
somente dentro do modo avançado.

O menu inicial precisa manter `{fluxos}` e a revisão precisa manter `{resumo}` para não ocultar
informações essenciais do usuário. Notificações persistentes de agenda são revalidadas antes do
envio; se o agendamento tiver sido removido ou substituído, o aviso antigo é cancelado em vez de ser
enviado fora de contexto.

## Instalação pelo GitHub

Esta versão é um plugin interno deste fork do OpenWA. Depois de clonar ou atualizar o repositório, execute no PowerShell:

```powershell
.\scripts\install-workflow-hub.ps1
```

O instalador baixa as dependências, aplica as migrations e compila backend e dashboard. Depois, inicie o OpenWA e habilite **Central de Recrutamento** na tela de plugins. O pacote antigo `talent-pool-rh` não deve ser habilitado junto com a Central de Recrutamento.

A Central de Recrutamento é um plugin nativo e um módulo interno do OpenWA. Ela substitui a dependência de Google Sheets/Drive por tabelas do banco de dados da própria aplicação e mantém o Banco de Talentos como um dos fluxos possíveis.

### Banco de Talentos separado do processo seletivo

Uma pergunta de seleção pode marcar uma de suas opções como `talentPoolOption`. Cadastros que escolherem essa opção aparecem na aba **Banco de Talentos**, com status operacional, responsável, observações e histórico próprios, e deixam de aparecer na listagem comum de candidatos enquanto não houver entrevista. Ao marcar a primeira entrevista, a entrada é convertida automaticamente, sai do Banco de Talentos e passa a integrar **Candidatos** e **Processo seletivo**, preservando a mesma ficha e o histórico da conversão.

## Ativação nesta instalação

1. Reinicie o OpenWA para carregar o backend e o painel recompilados.
2. No painel, abra **Plugins**, localize **Central de Recrutamento** (`workflow-hub`) e habilite o plugin para a sessão desejada.
3. Abra **Central de Recrutamento** no menu lateral.
4. Na aba **Fluxos**, use **Importar projeto atual** para transformar a configuração e os candidatos do Banco de Talentos existente no primeiro fluxo genérico. A importação é idempotente e desativa o motor legado interno ao terminar.
5. Desative também o plugin externo antigo `talent-pool-rh`, caso ele ainda esteja instalado, para impedir dois interceptadores na mesma conversa.
6. Crie ou edite outros fluxos, salve o rascunho e publique. Somente versões publicadas aparecem no WhatsApp.
7. Para fluxos que tenham um campo `appointment`, cadastre datas e horários na aba **Agenda**.

## Atualização pelo GitHub

Como o pacote possui entidades, migration, API e painel, ele deve ser distribuído junto ao repositório do OpenWA (não como um único JavaScript solto):

```powershell
git pull
npm ci
npm --prefix dashboard ci
npm run migration:run
npm run build
Set-Location dashboard
npm run build
```

Depois, reinicie o processo/container. A migration é incremental e cria somente tabelas `workflow_*`.

## Modelo operacional

- Uma sessão/número representa um setor.
- Cada setor contém vários fluxos publicados.
- Uma nova conversa abre o menu do setor; número ou palavra-chave escolhe o fluxo.
- Trocar de fluxo durante um preenchimento exige confirmação e apaga apenas o rascunho.
- O cadastro só é persistido depois do resumo e da confirmação.
- Versões publicadas são imutáveis; execuções abertas continuam presas à versão com que começaram.
- Ao publicar perguntas novas, somente campos alcançáveis pelo caminho correspondente às respostas já salvas são
  solicitados. Se nenhuma pergunta nova se aplicar ao cadastro, a versão é atualizada silenciosamente e o menu normal
  é exibido.
- Horários são exclusivos e reservados de forma condicional, evitando dupla escolha concorrente.
- No atendimento humano o bot fica silencioso. A inatividade gera aviso e, depois da tolerância, encerramento automático.
- Mensagens automáticas usam outbox persistente com três tentativas e backoff.
- Backup/restauração da infraestrutura inclui todas as tabelas da Central de Recrutamento.

## Arquivos centrais

- `src/modules/talent-pool/workflow-hub.service.ts`: motor e administração.
- `src/modules/talent-pool/entities/workflow-hub.entity.ts`: domínio persistente.
- `src/modules/talent-pool/workflow-hub.controller.ts`: API autenticada e limitada por sessão.
- `src/database/migrations/1786600000000-AddWorkflowHubCore.ts`: schema SQLite/PostgreSQL.
- `dashboard/src/pages/RecruitmentCenter.tsx`: entrada pública do painel unificado; o arquivo legado permanece como compatibilidade temporária.
