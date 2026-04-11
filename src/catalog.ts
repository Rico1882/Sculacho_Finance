export interface CatalogBank {
  code: string;
  name: string;
  segment: string;
}

export const BANK_CATALOG: readonly CatalogBank[] = [
  { code: '001', name: 'Banco do Brasil S.A.', segment: 'Banco múltiplo' },
  { code: '104', name: 'Caixa Econômica Federal', segment: 'Banco múltiplo' },
  { code: '033', name: 'Banco Santander (Brasil) S.A.', segment: 'Banco múltiplo' },
  { code: '237', name: 'Banco Bradesco S.A.', segment: 'Banco múltiplo' },
  { code: '341', name: 'Itaú Unibanco S.A.', segment: 'Banco múltiplo' },
  { code: '260', name: 'Nubank', segment: 'Instituição de pagamento' },
  { code: '077', name: 'Banco Inter S.A.', segment: 'Banco múltiplo' },
  { code: '212', name: 'Banco Original S.A.', segment: 'Banco múltiplo' },
  { code: '336', name: 'Banco C6 S.A.', segment: 'Banco múltiplo' },
  { code: '290', name: 'PagSeguro Internet S.A.', segment: 'Instituição de pagamento' },
  { code: '323', name: 'Mercado Pago Instituição de Pagamento Ltda.', segment: 'Instituição de pagamento' },
  { code: '380', name: 'PicPay Serviços S.A.', segment: 'Instituição de pagamento' },
  { code: '197', name: 'Stone Instituição de Pagamento S.A.', segment: 'Instituição de pagamento' },
  { code: '655', name: 'Banco Votorantim S.A.', segment: 'Banco múltiplo' },
  { code: '070', name: 'BRB - Banco de Brasília S.A.', segment: 'Banco múltiplo' },
  { code: '041', name: 'Banrisul', segment: 'Banco múltiplo' },
  { code: '021', name: 'Banestes', segment: 'Banco múltiplo' },
  { code: '047', name: 'Banese', segment: 'Banco múltiplo' },
  { code: '037', name: 'Banpará', segment: 'Banco múltiplo' },
  { code: '004', name: 'Banco do Nordeste do Brasil S.A.', segment: 'Banco múltiplo' },
  { code: '422', name: 'Banco Safra S.A.', segment: 'Banco múltiplo' },
  { code: '745', name: 'Banco Citibank S.A.', segment: 'Banco múltiplo' },
  { code: '069', name: 'Banco Crefisa S.A.', segment: 'Banco múltiplo' },
  { code: '389', name: 'Banco Mercantil do Brasil S.A.', segment: 'Banco múltiplo' },
  { code: '748', name: 'Banco Cooperativo Sicredi S.A.', segment: 'Banco cooperativo' },
  { code: '756', name: 'Banco Cooperativo do Brasil S.A. - Sicoob', segment: 'Banco cooperativo' },
];
