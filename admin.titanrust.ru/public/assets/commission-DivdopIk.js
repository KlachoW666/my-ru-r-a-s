function u(n){if(n==null||n==="")return null;const i=Number(n);return Number.isFinite(i)?`${((1-i)*100).toFixed(2)}%`:null}export{u as c};
