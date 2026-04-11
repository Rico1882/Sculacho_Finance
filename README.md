# Sculacho.com

Cockpit financeiro local para controlar fluxo de caixa, orcamentos, contas, metas e aportes com foco em privacidade.

## Visao geral

Sculacho.com e um aplicativo web local-first feito com Vite + TypeScript. Os dados ficam no navegador do usuario, com opcao de protecao por senha, backup JSON, exportacao CSV e importacao de extratos em CSV.

## Funcionalidades

- Dashboard com indicadores, alertas e posicao consolidada.
- Fluxo de caixa com filtros por status, importacao CSV, deduplicacao simples e recorrencias detectadas.
- Orcamentos mensais por categoria com alertas de risco.
- Gestao de contas/bancos com catalogo Brasil.
- Metas e aportes de investimento.
- Relatorios por conta, categoria, mes e ano.
- Backup JSON e exportacao CSV.
- Dados locais no navegador, sem servidor obrigatorio.

## Requisitos

- Node.js 18 ou superior
- npm

## Como rodar

```bash
npm install
npm run dev
```

Depois abra o endereco mostrado pelo Vite, normalmente:

```text
http://127.0.0.1:5173/
```

## Build

```bash
npm run build
```

O build de producao sera gerado em `dist/`.

## Preview de producao

```bash
npm run preview
```

## Observacoes de privacidade

Por padrao, os dados ficam no `localStorage` do navegador. O app tambem oferece protecao local por senha usando criptografia no navegador. Guarde backups JSON em local seguro.

## Publicacao

Este repositorio deve versionar o codigo-fonte. Arquivos gerados e sensiveis como `node_modules/`, `dist/`, backups `.zip` e planilhas pessoais ficam fora do Git pelo `.gitignore`.
