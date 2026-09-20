# Revisão da Central de Recrutamento — 11/09/2026

## Melhorias implementadas

### Edição e carregamento

- Requisições antigas deixam de atualizar a tela depois de uma nova carga, troca de sessão ou desmontagem.
- A agenda também descarta respostas antigas e apresenta erros de carregamento.
- O polling usa o estado atual da tela, respeita as abas de edição e pausa quando a página está oculta.
- O fechamento do modal de cadastro não é desfeito pelo retorno de uma atualização pendente.
- Configurações e mensagens editadas são preservadas quando dados operacionais são recarregados.
- Um salvamento lento não sobrescreve alterações digitadas depois do envio. Elas continuam pendentes e precisam de novo salvamento.
- Botões de salvar são bloqueados durante o envio, e a resposta salva atualiza também a versão conhecida pela tela.
- Trocar de fluxo ou de sessão com alterações pendentes apresenta um modal de descarte. Fechar/recarregar a página utiliza o aviso próprio do navegador.

### Diagrama

- Novas ligações que criariam ciclos são recusadas.
- O botão Organizar termina com segurança mesmo ao receber um rascunho antigo com ciclo.
- Há um painel de diagnóstico para caminhos padrão ausentes, blocos inacessíveis, mensagens vazias, condições incompletas e ciclos.
- Ao salvar um diagrama com esses problemas, a tela abre a aba Diagrama e informa o primeiro ajuste necessário. A API continua validando a definição completa.
- Uma pergunta com múltiplos caminhos de entrada não recebe automaticamente a condição de uma única ligação como restrição global.
- A organização visual não altera textos, respostas ou condições.
- O editor possui Desfazer e Refazer com até 50 pontos de histórico. Alterações contínuas do diagrama são agrupadas por uma pequena janela de tempo, evitando um item de histórico para cada pixel arrastado.
- Cada ponto do histórico guarda perguntas e grafo juntos; por isso, desfazer uma conexão condicional também restaura a regra correspondente da pergunta.
- Foi adicionado um simulador de caminho diretamente na aba Diagrama. Ele percorre ramificações, mensagens intermediárias, opções, consentimento, campos opcionais e `PULAR` sem gravar cadastro e sem enviar WhatsApp.

O simulador é uma prévia estrutural no navegador. Ele não executa scripts personalizados de validação, disponibilidade real de agenda nem upload de PDF. Uma evolução futura segura é criar um endpoint de _dry-run_ no backend que reutilize exatamente o executor publicado, sem produzir efeitos externos.

### Entrega de mensagens

O processamento filtrava mensagens com tentativas esgotadas **depois** de limitar o lote a 25 registros. Um acúmulo dessas falhas podia ocupar todos os lugares do lote e impedir indefinidamente o envio de respostas novas.

A filtragem agora acontece no banco antes do limite. O lote segue a data da próxima tentativa, com desempate por ID. Foi preservada a política existente de uma tentativa adicional de recuperação de falha. O teste de regressão cria 30 falhas esgotadas e uma resposta nova; somente a nova resposta deve ser enviada, uma vez.

O diagnóstico passa a distinguir falhas esgotadas de itens ainda elegíveis. Não foi efetuado reenvio manual nem alteração direta na outbox de produção.

Administradores agora têm a aba **Envios**, com contadores por estado, quantidade vencida aguardando processamento e falhas recentes classificadas por motivo. Essa visão é deliberadamente somente leitura: não mostra telefone, conteúdo, chave de deduplicação ou erro bruto e não oferece reenvio manual que possa duplicar uma mensagem.

### Validação e compatibilidade com Windows

- O campo `enabled` das ações de menu usa a conversão booleana estrita já adotada pelo projeto. Texto arbitrário não pode ativar uma opção por coerção implícita.
- Chaves de armazenamento enumeradas localmente usam `/` em todos os sistemas operacionais. Apenas o acesso ao disco usa o separador do sistema. Isso mantém consistência com as referências do banco e do S3 e corrige a identificação de mídias no Windows.
- Foram corrigidos erros de formatação identificados nos arquivos locais de autenticação, infraestrutura e migração. Nenhuma mudança de schema foi necessária.

## Verificação e limites

- Diagnóstico SQLite: zero erros de integridade, vínculos, capacidade, versões publicadas e estados de atendimento. Uma mensagem em `FALHA`, ainda dentro da política de recuperação, foi sinalizada; seu conteúdo não foi exposto nem reenviado.
- Testes de cadastro/atendimento/outbox: 37 aprovados.
- Testes de armazenamento, mídias e conversão de DTOs: 159 aprovados.
- Testes específicos de grafo, requisições e simulador: 18 aprovados.
- Novos testes de interface: atualização explícita preserva configurações; resposta lenta de salvamento preserva a digitação mais recente.
- Suíte completa do dashboard: 414 testes aprovados. Builds do backend e dashboard concluídos.
- Typecheck do dashboard aprovado. Lint do dashboard e dos arquivos de backend alterados sem erros. A verificação geral também identificou três avisos preexistentes de promises em testes de contatos.
- A suíte geral do backend foi executada. Ela não está inteiramente verde neste Windows. Além dos defeitos corrigidos acima, há falhas em testes de permissões POSIX, limpeza de Chromium, dependência do executável `patch`, criação de symlinks, importação de arquivos e leitura de serviços do Compose. O subconjunto com falhas foi repetido fora da restrição de subprocessos; isso não eliminou as diferenças de plataforma nem a ausência de ferramentas.
- Não foram testados envios reais pelo WhatsApp nem um servidor PostgreSQL. A consulta da outbox preserva o transformador de datas e usa o QueryBuilder do TypeORM, mas precisa também da cobertura PostgreSQL no CI.
- Os testes de interface usam DOM simulado; não substituem a inspeção visual em um navegador real.
- A verificação de formatos dos contratos encontrou dívida anterior no SDK Python (77 tipos manuais ausentes). Dashboard, SDK JavaScript, Go e Java permaneceram conformes; esta entrega não alterou os clientes Python.

## Próximas melhorias recomendadas

1. Evoluir o simulador local para um _dry-run_ no backend, reutilizando validações personalizadas e agenda sem persistência ou envio.
2. Estabelecer duas execuções de CI, Windows e Linux, além da integração PostgreSQL, distinguindo capacidades de sistema operacional sem ignorar testes de segurança.
3. Corrigir a defasagem dos tipos manuais do SDK Python indicada pela verificação de formatos dos contratos.
4. Extrair os formulários de configurações e agenda da página principal para componentes com responsabilidade própria e ampliar os testes de navegação entre sessões.
5. Se futuramente houver recuperação manual da outbox, exigir revalidação do estado atual, autorização administrativa, auditoria e uma nova chave idempotente antes de qualquer reenvio.

Esses itens são recomendações futuras, não funcionalidades já entregues nesta revisão.

## Referências pesquisadas

- [React: sincronização com Effects](https://react.dev/learn/synchronizing-with-effects) — cancelar ou ignorar resultados obsoletos de requisições.
- [React: separar eventos de Effects](https://react.dev/learn/separating-events-from-effects) — ler valores atuais em callbacks de efeitos sem depender de closures antigas.
- [React Flow: validação de conexões](https://reactflow.dev/examples/interaction/validation) — validar ligações antes de inseri-las no editor.
