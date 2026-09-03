'use strict';
function makeGlobalStats({queryAdminDb,baseOnline=0}) {
  const count=value=>Number.isFinite(Number(value))?Math.max(0,Math.floor(Number(value))):0;
  async function read() {
    const one=async(sql,p=[])=>{
      const rows=await queryAdminDb(sql,p);
      if(rows.failed)throw new Error('Statistics query failed');
      return count(rows[0]?.v);
    };
    const [totalCases,totalUpgrades,totalUsers,battlesCount,realOnline,settings]=await Promise.all([
      one("SELECT COUNT(*) v FROM transactions WHERE type='case_open'"),
      one("SELECT COUNT(*) v FROM transactions WHERE type='upgrade'"),
      one('SELECT COUNT(*) v FROM users'),
      one("SELECT COUNT(*) v FROM battles WHERE status='finished'"),
      one("SELECT COUNT(DISTINCT user_id) v FROM transactions WHERE julianday(created_at) BETWEEN julianday('now','-15 minutes') AND julianday('now')"),
      queryAdminDb("SELECT value FROM app_settings WHERE key='bots_config'")
    ]);
    if(settings.failed)throw new Error('Cannot read online configuration');
    const config=settings[0]?.value?JSON.parse(settings[0].value):{};
    // Explicit zero in admin must override the legacy environment fallback.
    const simulatedOnline=count(config.onlineSim?.baseCount??baseOnline);
    const stats={totalCases,totalUpgrades,totalUsers,online:realOnline+simulatedOnline,realOnline,simulatedOnline};
    return {stats,onlineCount:stats.online,openedCasesCount:totalCases,upgradesCount:totalUpgrades,battlesCount};
  }
  async function publish(wss) {
    if(!wss.clients.size)return;
    const message=JSON.stringify({event:'stats:updated',data:(await read()).stats});
    for(const client of wss.clients)if(client.readyState===1)client.send(message);
  }
  return {read,publish};
}
module.exports={makeGlobalStats};
