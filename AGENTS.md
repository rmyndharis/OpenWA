# AGENTS.md — Guia de desenvolvimento do OpenWA

Este arquivo orienta agentes de código e colaboradores humanos que trabalham neste repositório. Ele se aplica a todo o projeto, salvo quando um diretório possuir um `AGENTS.md` mais específico.

Em caso de conflito, siga nesta ordem: instruções explícitas do responsável pela tarefa, o `AGENTS.md` mais próximo do arquivo alterado, este documento e, por último, a documentação geral. Documentos históricos ajudam a entender decisões anteriores, mas o código, as migrações e os contratos vigentes são a referência do comportamento atual.

## 1. Objetivo do projeto

Este repositório contém o OpenWA, um gateway de WhatsApp auto-hospedado, e a Central de Fluxos integrada. A Central de Fluxos permite criar formulários conversacionais, cadastros, ramificações, agendas e atendimentos humanos para diferentes setores e números de WhatsApp.

O produto deve permanecer genérico. “Banco de Talentos” é apenas um fluxo possível, não o nome nem a finalidade exclusiva do módulo.

Prioridades, nesta ordem:

1. Preservar dados e privacidade.
2. Não enviar mensagens duplicadas ou indevidas.
3. Manter o bot silencioso durante atendimento humano.
4. Manter compatibilidade com instalações existentes.
5. Oferecer uma interface compreensível para administradores e operadores.
6. Entregar mudanças testadas e observáveis.

## 2. Regras de trabalho

- Leia este arquivo antes de alterar o projeto.
- Antes de editar, examine os arquivos relacionados, testes, DTOs, entidades, migrações e chamadas do frontend.
- Procure arquivos e símbolos com `rg` e `rg --files`.
- Faça alterações pequenas e focadas. Evite refatorações não relacionadas ao pedido atual.
- Preserve mudanças locais já existentes. O diretório pode estar com arquivos alterados ou não rastreados.
- Não use `git reset --hard`, `git checkout --`, limpeza ampla ou exclusão recursiva para desfazer trabalho.
- Use `apply_patch` para alterações manuais em arquivos.
- Não edite artefatos gerados em `dist/`. Altere o código-fonte e execute o build.
- Não altere dependências ou o lockfile sem necessidade comprovada.
- Não exponha chaves, tokens, mensagens privadas, currículos ou dados pessoais em logs, testes, commits ou respostas.
- Explique suposições importantes e confirme comportamentos de alto impacto com evidências do código.
- Ao concluir, informe arquivos alterados, comportamento entregue, comandos executados e qualquer risco ou pendência real.

### 2.1 Limites de autorização

Uma solicitação para analisar, diagnosticar ou revisar não autoriza alterações funcionais nem ações externas. Para mudanças solicitadas, implemente e valide localmente, mas obtenha autorização explícita antes de:

- criar ou trocar de branch quando isso mudar o fluxo de trabalho combinado;
- executar `git commit`, `git push`, merge, rebase, tag ou criação de release;
- aplicar ou reverter migrações em qualquer banco conectado;
- iniciar, encerrar, excluir ou recriar sessões reais do WhatsApp;
- enviar mensagens reais, disparar avisos em massa ou testar com contatos externos;
- alterar segredos, credenciais, domínios, firewall, infraestrutura ou configuração de produção;
- executar deploy, rollback remoto ou qualquer ação destrutiva ou difícil de reverter.

A autorização vale somente para a ação e o alvo descritos. Commit, push, migration e deploy são checkpoints distintos. Comandos de leitura, testes locais e builds não destrutivos podem ser executados como parte normal da implementação.

## 3. Estrutura relevante

### Stack confirmada

- Backend em Node.js/TypeScript com NestJS.
- Persistência com TypeORM em conexões separadas, com suporte a SQLite e PostgreSQL.
- Dashboard em React/TypeScript com Vite.
- Integrações de WhatsApp encapsuladas pelos engines e pelo registro de sessões do OpenWA.
- Contrato HTTP documentado em `openapi.json` e validado pelos testes de contrato do repositório.

### Backend

- `src/`: aplicação NestJS.
- `src/modules/`: módulos HTTP e de domínio.
- `src/modules/talent-pool/`: implementação histórica e atual da Central de Fluxos.
- `src/modules/talent-pool/workflow-hub.service.ts`: orquestração principal dos fluxos.
- `src/modules/talent-pool/workflow-hub.controller.ts`: API HTTP da Central de Fluxos.
- `src/modules/talent-pool/dto/`: contratos e validação de entrada.
- `src/modules/talent-pool/entities/`: entidades e tipos persistidos.
- `src/core/hooks/`: cadeia de eventos e interceptação de mensagens.
- `src/core/plugins/`: infraestrutura geral de plugins.
- `src/database/migrations/`: migrações do banco de dados operacional.
- `src/database/migrations-main/`: migrações de autenticação e auditoria.
- `scripts/workflow-hub-doctor.ts`: diagnóstico da consistência da Central de Fluxos.

### Dashboard

- `dashboard/src/pages/TalentPool.tsx`: tela principal da Central de Fluxos.
- `dashboard/src/pages/TalentPool.css`: estilos isolados pela raiz `.talent-page`.
- `dashboard/src/components/WorkflowDiagram.tsx`: editor visual do diagrama.
- `dashboard/src/utils/workflowGraph.ts`: criação e reconciliação do grafo.
- `dashboard/src/services/api.ts`: contratos e cliente HTTP do painel.
- `dashboard/src/hooks/useRole.ts`: permissões da interface.

### Operação e distribuição

- `plugins/`: pacotes externos ou legados distribuíveis. Não confundir com módulos internos do NestJS.
- `data/`: bancos e dados locais de execução. Nunca trate arquivos daqui como código-fonte.
- `docs/`: documentação técnica e operacional.
- `openapi.json`: contrato público exportado da API.
- `docker-compose*.yml`, `Dockerfile` e `charts/`: implantação.

### Fluxo de trabalho recomendado

1. Leia `git status --short --branch` e preserve o trabalho existente.
2. Confirme o escopo, os critérios de aceite e os perfis afetados.
3. Localize com `rg` o caminho completo: interface, cliente HTTP, DTO, controller, serviço, entidade, migration e testes.
4. Identifique invariantes, efeitos colaterais, concorrência e compatibilidade antes de editar.
5. Implemente a menor mudança coerente, sem duplicar fontes de verdade.
6. Adicione ou atualize testes proporcionais ao risco.
7. Execute primeiro os testes direcionados e depois os gates mais amplos aplicáveis.
8. Revise o diff, execute `git diff --check` e verifique se não há dados sensíveis ou artefatos gerados.
9. Entregue um resumo com validações, riscos reais e passos que ainda exigem autorização.

## 4. Arquitetura e limites

### 4.1 Módulo interno e plugin

A Central de Fluxos é um módulo interno do OpenWA. Um pacote distribuído como plugin pode instalar, habilitar ou integrar esse recurso, mas não deve duplicar entidades, regras de negócio ou tabelas em uma segunda implementação.

- O backend é a fonte de verdade.
- O dashboard consome a API; não reimplementa regras críticas do domínio.
- Plugins externos devem usar contratos públicos e estáveis.
- Não reative o controller legado do Banco de Talentos. A superfície oficial é `workflow-hub`.
- Preserve a migração de instalações legadas enquanto houver dados antigos suportados.

### 4.2 Bancos de dados

O projeto possui duas conexões distintas:

- `data`: sessões, mensagens, automações, integrações e Central de Fluxos. Configurada em `src/database/data-source.ts`.
- `main`: autenticação e auditoria. Configurada em `src/database/data-source-main.ts`.

Regras obrigatórias:

- Entidades da Central de Fluxos pertencem à conexão `data`.
- Chaves de API e auditoria global pertencem à conexão `main`.
- Nunca mova uma entidade entre conexões sem um plano explícito de migração.
- Nunca use `synchronize: true` como solução para evolução de schema.
- Toda alteração persistente exige migração.
- Considere SQLite e PostgreSQL em DDL, tipos, defaults, índices e consultas.
- Não edite diretamente um banco do usuário para implementar uma funcionalidade.

## 5. Invariantes da Central de Fluxos

Estas regras são parte do produto e não podem ser quebradas por conveniência de implementação.

### 5.1 Setores, sessões e fluxos

- Cada número/sessão do WhatsApp pertence a um setor.
- Um setor pode possuir vários fluxos.
- Cada conversa executa apenas um fluxo por vez.
- O menu inicial apresenta os fluxos publicados disponíveis.
- Uma palavra-chave pode abrir diretamente um fluxo.
- A troca de fluxo exige confirmação quando houver trabalho temporário em andamento.
- Um novo fluxo não deve assumir regras exclusivas de RH.

### 5.2 Cadastro e atualização

- Dados incompletos ficam temporários até confirmação final.
- Cadastro válido e rascunho de atualização são registros conceitualmente separados.
- Timeout de cadastro remove apenas os dados temporários daquele cadastro.
- Timeout ou cancelamento de atualização nunca altera nem apaga o cadastro válido existente.
- Ao expirar, uma nova mensagem começa o fluxo novamente sem recuperar respostas parciais antigas.
- Respostas válidas reiniciam o prazo de inatividade do fluxo.
- Uma resposta `PULAR` em campo opcional deve ser registrada com o marcador interno previsto pelo sistema e considerada respondida.
- O marcador interno de campo pulado não deve ser exibido literalmente ao usuário.
- Quando o schema mudar, solicite somente campos novos ou alterados que sejam alcançáveis no caminho atual e visíveis para as respostas já salvas.
- Uma pergunta adicionada em outro ramo não deve tornar o cadastro do usuário incompleto.
- Dados definitivos só são gravados depois de validação e confirmação.

### 5.3 Perguntas e grafo

- `WorkflowFieldDefinition.id` identifica uma etapa do diagrama e deve ser único na versão.
- `answerKey` identifica o campo de dados salvo.
- O mesmo `answerKey` só pode ser reutilizado por etapas mutuamente exclusivas e com tipo compatível.
- O grafo persistido fica em `WorkflowDefinitionVersion.definition.graph`.
- Mudanças visuais no grafo precisam afetar a execução real; não crie um diagrama apenas decorativo.
- Toda etapa alcançável deve possuir uma saída válida ou chegar ao fim do fluxo.
- Não permita arestas órfãs, referências a etapas removidas ou ciclos não suportados.
- Ao remover uma pergunta, reconcilie o grafo preservando o caminho possível entre as etapas restantes.
- Use IDs estáveis como `key` no React. Não use índice quando o item pode ser reordenado, inserido ou removido.

### 5.4 Mensagens personalizadas

- Mensagens do fluxo usam `WorkflowInstance.messages`.
- A mensagem inicial do setor usa `WorkflowDepartment.messages.sectorMenu`.
- Configurações e Diagrama devem editar a mesma fonte de dados, sem cópias divergentes.
- Campo vazio significa usar o texto padrão, salvo quando o contrato declarar outro comportamento.
- Preserve placeholders documentados, como `{setor}`, `{fluxos}`, `{fluxo}`, `{contexto}`, `{resumo}`, `{data}`, `{hora}`, `{local}` e `{minutos}`.
- Novos placeholders precisam de implementação, validação, documentação e teste.
- Não grave conteúdo dinâmico já renderizado como template permanente.
- Não envie mensagens administrativas antigas que tenham perdido a relação com o estado atual.

### 5.5 Atendimento humano

- Um contato não pode possuir mais de um chamado humano aberto no mesmo escopo.
- Durante `EM_ATENDIMENTO_HUMANO` ou estado equivalente, o bot não interpreta, não responde, não exibe menu e não inicia automações conversacionais.
- Mensagem do cliente, mensagem do atendente e ação manual relevante atualizam a última atividade.
- Depois do período configurado de inatividade, envie um único aviso.
- Se houver atividade no período de tolerância, cancele o encerramento e reinicie o contador.
- Antes de executar um job de aviso ou encerramento, releia e valide o estado e o prazo persistidos.
- O encerramento preserva o histórico e registra motivo e horário.
- Após encerrar, a próxima mensagem volta ao fluxo normal; não responda antecipadamente no momento do fechamento além do aviso configurado.

### 5.6 Agenda

- Um horário possui capacidade configurável e deixa de ser oferecido quando está lotado, bloqueado, removido ou expirado.
- A confirmação deve ocorrer de forma transacional para impedir excesso de capacidade.
- Remoção simples é permitida apenas quando não há agendamentos ativos relacionados.
- Remover ou cancelar um agendamento deve limpar a referência correspondente dos dados apresentados no cadastro.
- Quando um horário com pessoas confirmadas for substituído, mova os agendamentos de forma atômica, retire o horário antigo e avise somente os usuários realmente afetados.
- Reagendamento e cancelamento devem ser idempotentes.
- Lembretes devem ser enviados uma única vez, no fuso horário do setor, e registrar seu processamento.

### 5.7 Privacidade e retenção

- Solicitação de exclusão fica pendente e bloqueia o fluxo até decisão administrativa.
- Aprovação deve apagar os dados pessoais definidos pelo produto, preservar somente o mínimo legal/auditável e enviar uma única confirmação ao usuário.
- Não inclua dados confidenciais em listagens ou mensagens de consulta.
- Respeite visibilidade, editabilidade e confidencialidade definidas por campo.
- A política padrão de retenção deve continuar configurável; não hardcode períodos em serviços ou componentes.

## 6. Idempotência, concorrência e jobs

Todo ponto que processa mensagens, webhooks ou jobs deve assumir entrega repetida e concorrente.

- Use o identificador original da mensagem/evento como chave de idempotência.
- Registre processamento antes ou dentro da mesma transação da mudança de estado.
- Use transação, bloqueio pessimista/otimista ou restrição única conforme o caso.
- Prefira índices/restrições no banco para invariantes que não podem depender apenas da aplicação.
- Um retry não pode duplicar cadastro, chamado, agendamento, evento, aviso ou mensagem de saída.
- Jobs devem carregar novamente o registro e comparar estado, prazo e versão antes de agir.
- Jobs obsoletos devem terminar sem efeitos.
- Mensagens de saída devem usar a outbox persistente quando fizerem parte de uma transação de domínio.
- Limite retries, registre a falha terminal e evite filas eternas.
- Não confie apenas em timers em memória. Reiniciar a aplicação não pode perder prazos importantes.

## 7. API, DTOs e autenticação

- Toda entrada HTTP deve passar por DTO explícito com `class-validator`.
- O projeto rejeita propriedades desconhecidas. Não envie entidades completas do frontend para endpoints de atualização.
- DTOs de criação e atualização devem aceitar somente campos graváveis pelo cliente.
- Nunca aceite do cliente campos como `id`, `sessionId`, timestamps, estado interno ou campos de auditoria sem uma necessidade formal.
- Atualize em conjunto: DTO, controller, service, tipos de `dashboard/src/services/api.ts`, testes e `openapi.json` quando o contrato público mudar.
- Use `@SessionScoped()` para rotas vinculadas à sessão.
- Use `@RequireRole(...)` com o menor privilégio necessário.
- `ADMIN`: configura fluxos, publica, gerencia privacidade e pode excluir registros.
- `OPERATOR`: consulta registros/chamados e realiza ações operacionais autorizadas.
- `VIEWER`: leitura limitada conforme os contratos existentes.
- Respeite `allowedChats` em toda consulta ou mutação que exponha conversas, pessoas, agendamentos ou chamados.
- Validar somente no frontend não é controle de acesso.
- Não coloque chave de API em URL, query string, log ou mensagem de erro.

## 8. Backend: método recomendado

Para cada funcionalidade de domínio:

1. Defina as invariantes e os estados de origem/destino.
2. Localize entidade, DTO, controller, service, jobs e testes existentes.
3. Modele a alteração persistente e escreva a migração quando necessário.
4. Implemente a operação principal em um método de serviço com transação quando houver mais de uma gravação relacionada.
5. Faça a checagem de permissão e escopo no controller e novamente na consulta do service.
6. Adicione idempotência e proteção contra concorrência.
7. Registre auditoria sem dados pessoais desnecessários.
8. Agende a saída por outbox quando ela depender da gravação concluída.
9. Cubra caminho feliz, validação, repetição, concorrência e estado obsoleto com testes.

Boas práticas adicionais:

- Controllers devem ser finos.
- Não devolva entidades internas diretamente se isso expuser campos indevidos.
- Erros enviados ao usuário devem ser úteis, mas não revelar SQL, tokens ou detalhes internos.
- Use enums/constantes para estados e motivos persistidos.
- Centralize transições complexas; evite alterar o mesmo estado em vários lugares sem uma função comum.
- Datas persistidas são UTC. Converta para o fuso do setor apenas na apresentação ou no cálculo que explicitamente o exigir.

## 9. Dashboard: método recomendado

Para cada alteração de interface:

1. Confirme qual perfil pode visualizar e qual pode alterar.
2. Reutilize o cliente de API e os tipos existentes.
3. Mantenha uma única fonte de verdade para cada formulário.
4. Use estado local para rascunhos e só confirme o estado salvo depois da resposta da API.
5. Mostre carregamento, sucesso, erro, estado vazio e bloqueio de permissão.
6. Preserve entradas durante atualização automática da página.
7. Use IDs estáveis em listas editáveis para evitar perda de foco.
8. Teste teclado, foco, rótulos e telas estreitas.

Regras de interface:

- Evite `window.alert`, `window.confirm` e `window.prompt` em novas funcionalidades. Use `Modal` e componentes do projeto.
- Não faça polling substituir silenciosamente um formulário que o usuário está editando.
- Desabilite ações incompatíveis com alterações não salvas e explique o motivo.
- Um menu flutuante deve permanecer acima da tabela e dentro da área visível.
- Toda entrada precisa de nome acessível; botões apenas com ícone precisam de `aria-label` e `title` quando útil.
- Estilos de página devem permanecer sob a classe raiz da página, como `.talent-page`.
- Use variáveis de tema; evite cores soltas quando existir token equivalente.
- Componentes grandes devem ser extraídos quando possuem estado ou responsabilidade própria.
- O diagrama é o editor do caminho; a lista de perguntas é o editor detalhado do conteúdo. Ambos devem compartilhar os mesmos campos e grafo.
- Operadores podem visualizar dados permitidos, mas controles administrativos não devem apenas parecer desativados: a API também deve negar a mutação.

## 10. Migrações

### Banco operacional (`data`)

Criar:

```bash
npm run migration:create --name=NomeDaMigracao
```

Executar em desenvolvimento:

```bash
npm run migration:run
```

Verificar estado:

```bash
npm run migration:show
```

### Banco principal (`main`)

Criar/gerar e executar somente para autenticação ou auditoria global:

```bash
npm run migration:generate:main --name=NomeDaMigracao
npm run migration:run:main
```

Regras para migrações:

- Implemente `up` e `down` quando a reversão for tecnicamente segura.
- Não apague dados existentes para facilitar uma mudança de tipo.
- Faça backfill explícito e determinístico.
- Para novas colunas obrigatórias, planeje default/backfill antes de aplicar `NOT NULL`.
- Adicione índices para chaves de busca, idempotência, prazos de jobs e relacionamentos frequentes.
- Teste migração em banco com dados antigos, não apenas vazio.
- Não reutilize timestamp ou nome de migração existente.
- Atualize fixtures de drift somente depois de revisar que a mudança é intencional.

## 11. Testes e validação

Execute primeiro os testes mais próximos da mudança e depois amplie.

### Backend direcionado

```bash
npx jest src/modules/talent-pool/workflow-hub.service.spec.ts --runInBand
npx jest src/modules/talent-pool/talent-pool.service.spec.ts --runInBand
```

### Backend completo

```bash
npm run lint
npm test -- --runInBand
npm run build
```

### Diagnóstico da Central de Fluxos

Com o ambiente configurado e quando a mudança tocar dados reais:

```bash
npm run doctor:workflow
```

O diagnóstico deve terminar sem erros. Avisos devem ser investigados e explicados; não os esconda para obter saída verde.

### Dashboard

```bash
cd dashboard
npm run typecheck
npm run lint
npm test
npm run build
```

### Contratos e migrações

Quando aplicável:

```bash
npm run test:docs
npm run check:contract-shapes
npm run openapi:export
npm run migration:show
```

No Windows ou em ambientes restritos, runners podem falhar com `spawn EPERM`. Isso é uma limitação do ambiente, não uma falha de teste. Execute novamente em um contexto autorizado; não altere o código ou desative testes para contornar a restrição.

## 12. Estratégia de testes por risco

Toda correção de bug deve incluir, quando viável, um teste que falhava antes da correção.

Casos mínimos para a Central de Fluxos:

- mensagem duplicada processada duas vezes;
- duas respostas simultâneas para o mesmo contato;
- timeout que encontra estado já alterado;
- cadastro expirado sem recuperação de dados parciais;
- atualização expirada preservando cadastro válido;
- pergunta nova em ramo irrelevante não solicitada;
- pergunta nova alcançável solicitada uma única vez;
- `PULAR` em campo opcional não volta como pendência;
- atendimento humano mantém o bot silencioso;
- aviso de inatividade cancelado por nova atividade;
- apenas um chamado humano aberto por contato;
- agenda impede ultrapassar capacidade;
- cancelamento limpa a resposta de agenda apresentada no perfil;
- reagendamento move somente agendamentos do horário original;
- outbox não envia mensagem obsoleta;
- operador enxerga somente chats permitidos;
- operador não executa ação exclusiva de administrador;
- reinicialização preserva estados e prazos.

## 13. Logs e auditoria

- Use logs estruturados com identificadores técnicos necessários: `sessionId`, `instanceId`, `runId`, `ticketId`, `requestId` e chave de idempotência.
- Não registre corpo completo de mensagem, currículo, e-mail, CPF, telefone completo, token OAuth, segredo de cliente ou chave de API.
- Para correlação sem exposição, use identificador interno ou fingerprint não reversível quando apropriado.
- Registre transições importantes: criação, publicação, início, expiração, confirmação, atualização, abertura/encerramento de chamado, agendamento, cancelamento, reagendamento e exclusão.
- Diferencie erro transitório de falha terminal.
- Um log de sucesso só deve ser emitido após a transação correspondente ser concluída.

## 14. Segurança

- Trate conteúdo do WhatsApp, nomes de arquivo, templates, scripts de validação e JSON administrativo como entrada não confiável.
- Não execute código personalizado sem isolamento, limites de tempo, limites de memória e uma lista explícita de capacidades.
- Valide upload por tipo real, extensão, tamanho e finalidade. Currículos aceitam somente PDF quando essa for a configuração do fluxo.
- Neutralize fórmulas em exportações CSV/planilha.
- Previna path traversal em uploads e downloads.
- Preserve proteções SSRF em qualquer integração HTTP.
- Não reduza CSP, autenticação, throttling ou validação para resolver problema de desenvolvimento.
- Mudanças em exclusão, retenção, OAuth, permissões e arquivos exigem revisão de segurança proporcional ao risco.

## 15. Compatibilidade e evolução

- Prefira mudanças aditivas em API e schema.
- Não renomeie estados, colunas ou chaves persistidas sem migração e compatibilidade de leitura.
- Mantenha defaults existentes ao adicionar configurações opcionais.
- Versões publicadas de fluxo são imutáveis. Edições devem ocorrer em rascunho e entrar em vigor após publicação.
- Uma conversa já iniciada deve continuar com a versão definida para sua execução, salvo regra explícita de migração.
- A interface pode adotar nomes mais genéricos, mas nomes técnicos legados só devem ser removidos depois de migrar imports, tabelas, rotas, dados e integrações.

## 16. Checklist de revisão

Antes de considerar uma mudança pronta, confirme:

### Comportamento

- O fluxo feliz funciona do início ao fim.
- Cancelamento, timeout e retry deixam estado consistente.
- Não há possibilidade evidente de mensagem duplicada.
- O modo humano continua silencioso.
- Cadastro válido não é apagado por timeout de rascunho.
- Regras de agenda e capacidade permanecem corretas.

### Dados

- A conexão de banco correta foi usada.
- Há migração para qualquer mudança de schema.
- A operação é transacional quando necessário.
- Há idempotência e índices/restrições adequados.
- Jobs revalidam estado antes de produzir efeitos.

### API e permissões

- DTO rejeita propriedades indevidas.
- Role e escopo de sessão/chat são aplicados.
- Tipos do frontend correspondem ao contrato.
- OpenAPI foi atualizado quando necessário.

### Interface

- A tela informa claramente o que está sendo editado.
- Campos não perdem foco nem conteúdo durante atualização.
- Modais fecham corretamente após sucesso.
- Erros de respostas vazias ou `204` são tratados sem tentar analisar JSON inexistente.
- Layout funciona em desktop e tela estreita.
- Controles possuem rótulo acessível.

### Qualidade

- Formatação e lint foram executados.
- Testes direcionados e builds passaram.
- `git diff --check` não aponta whitespace inválido.
- O diff não contém segredos, artefatos gerados ou mudanças alheias ao pedido.
- A documentação foi atualizada quando o comportamento operacional mudou.

## 17. Critério de conclusão

Uma tarefa não está concluída apenas porque compila. Ela está concluída quando:

1. O comportamento solicitado foi implementado na arquitetura existente.
2. As invariantes do domínio continuam preservadas.
3. O banco pode evoluir com segurança em uma instalação existente.
4. Backend e frontend concordam sobre o contrato.
5. Permissões são impostas no servidor.
6. Cenários de falha, repetição e reinicialização foram considerados.
7. Testes proporcionais ao risco passaram.
8. O resultado foi explicado de forma objetiva, incluindo qualquer limitação restante.
