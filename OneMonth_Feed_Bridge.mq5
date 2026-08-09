//+------------------------------------------------------------------+
//|              OneMonth_Feed_Bridge.mq5                            |
//| V44 MT5-first auto hybrid feed + progressive historical academy  |
//| DATA ONLY: no orders, no positions, no account modifications     |
//+------------------------------------------------------------------+
#property strict
#property version   "44.00"
#property description "OneMonth V44 MT5 auto-hybrid XAUUSD M1 bridge + progressive history backfill"

input string InpSymbol = "";
input string InpWorkerBaseURL = "https://onemonth-tv-feed.nutchaphonsit.workers.dev";
input string InpWebhookToken = "PUT_YOUR_TOKEN_HERE";
input int    InpTimerSeconds = 3;
input int    InpTimeoutMs = 10000;
input bool   InpSendLastClosedOnStart = true;
input bool   InpBackfillOnStart = true;
input int    InpBackfillBars = 60000;
input int    InpBatchSize = 200;
input int    InpBackfillBatchesPerTimer = 3;
input int    InpHeartbeatSeconds = 30;
input bool   InpVerboseLog = true;

string   g_symbol = "";
datetime g_lastSentBarTime = 0;
int      g_sentCount = 0;
int      g_failCount = 0;
int      g_backfillCount = 0;
int      g_backfillTarget = 0;
bool     g_backfillDone = false;
ulong    g_lastHeartbeatTick = 0;

void Log(string text)
{
   if(InpVerboseLog)
      Print("[OneMonth V44 Feed] ", text);
}

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", "");
   StringReplace(value, "\n", "");
   return value;
}

string FeedSymbol()
{
   if(StringLen(InpSymbol) > 0)
      return InpSymbol;
   return _Symbol;
}

bool IsXAUUSD(string symbol)
{
   string s=symbol;
   StringToUpper(s);
   return StringFind(s,"XAUUSD") >= 0;
}

int SymbolDigitsSafe(string symbol)
{
   long d=2;
   if(SymbolInfoInteger(symbol,SYMBOL_DIGITS,d))
      return (int)d;
   return 2;
}

string TrimBaseURL(string url)
{
   while(StringLen(url)>0 && StringSubstr(url,StringLen(url)-1,1)=="/")
      url=StringSubstr(url,0,StringLen(url)-1);
   return url;
}

string BarJson(string symbol,MqlRates &bar,bool heartbeat=false)
{
   int digits=SymbolDigitsSafe(symbol);
   string s="{";
   s+="\"source\":\"MT5\",";
   s+="\"symbol\":\""+JsonEscape(symbol)+"\",";
   s+="\"timeframe\":\"1\",";
   s+="\"ts\":"+IntegerToString((long)bar.time)+",";
   s+="\"open\":"+DoubleToString(bar.open,digits)+",";
   s+="\"high\":"+DoubleToString(bar.high,digits)+",";
   s+="\"low\":"+DoubleToString(bar.low,digits)+",";
   s+="\"close\":"+DoubleToString(bar.close,digits)+",";
   s+="\"heartbeat\":"+(heartbeat?"true":"false");
   s+="}";
   return s;
}

bool StringToUtf8(string text,char &data[])
{
   ArrayResize(data,0);
   int copied=StringToCharArray(text,data,0,WHOLE_ARRAY,CP_UTF8);
   if(copied<=0) return false;
   if(ArraySize(data)>0) ArrayResize(data,ArraySize(data)-1);
   return true;
}

bool HttpPostJson(string endpoint,string payload,string &response,int &httpCode)
{
   if(StringLen(InpWebhookToken)<8)
   {
      Log("ERROR: WEBHOOK_TOKEN missing");
      return false;
   }

   char requestData[],responseData[];
   if(!StringToUtf8(payload,requestData))
   {
      Log("ERROR: UTF-8 payload build failed");
      return false;
   }

   string headers="Content-Type: application/json\r\n";
   headers+="Authorization: Bearer "+InpWebhookToken+"\r\n";
   headers+="User-Agent: OneMonth-MT5-Bridge/44.0\r\n";
   string responseHeaders="";
   ResetLastError();

   httpCode=WebRequest("POST",endpoint,headers,InpTimeoutMs,requestData,responseData,responseHeaders);
   if(httpCode==-1)
   {
      int err=GetLastError();
      g_failCount++;
      Log("WEBREQUEST FAILED | error="+IntegerToString(err));
      if(err==4014)
         Log("Allow WebRequest URL: "+TrimBaseURL(InpWorkerBaseURL));
      return false;
   }

   response=CharArrayToString(responseData,0,-1,CP_UTF8);
   if(httpCode>=200 && httpCode<300)
      return true;

   g_failCount++;
   Log("HTTP ERROR "+IntegerToString(httpCode)+" | "+response);
   return false;
}

bool SendSingleBar(string symbol,MqlRates &bar,bool heartbeat=false)
{
   string response="";
   int code=0;
   string endpoint=TrimBaseURL(InpWorkerBaseURL)+"/mt5-webhook";
   bool ok=HttpPostJson(endpoint,BarJson(symbol,bar,heartbeat),response,code);
   if(ok)
   {
      if(!heartbeat) g_sentCount++;
      g_lastHeartbeatTick=GetTickCount64();
      if(!heartbeat)
         Log("LIVE OK | "+TimeToString(bar.time,TIME_DATE|TIME_MINUTES)+" | close="+DoubleToString(bar.close,SymbolDigitsSafe(symbol))+" | HTTP "+IntegerToString(code));
   }
   return ok;
}

bool SendBatch(string symbol,MqlRates &rates[],int count)
{
   if(count<=0) return true;
   string payload="{\"source\":\"MT5_BACKFILL\",\"bars\":[";
   for(int i=0;i<count;i++)
   {
      if(i>0) payload+=",";
      payload+=BarJson(symbol,rates[i],false);
   }
   payload+="]}";

   string response="";
   int code=0;
   string endpoint=TrimBaseURL(InpWorkerBaseURL)+"/mt5-batch";
   bool ok=HttpPostJson(endpoint,payload,response,code);
   if(ok)
   {
      g_backfillCount+=count;
      Log("BACKFILL OK | +"+IntegerToString(count)+" | "+IntegerToString(g_backfillCount)+"/"+IntegerToString(g_backfillTarget));
   }
   return ok;
}

void BackfillStep()
{
   if(!InpBackfillOnStart || g_backfillDone) return;
   if(g_backfillCount>=g_backfillTarget)
   {
      g_backfillDone=true;
      Log("BACKFILL COMPLETE | stored/upserted="+IntegerToString(g_backfillCount));
      return;
   }

   int batch=MathMax(25,MathMin(InpBatchSize,250));
   int rounds=MathMax(1,MathMin(InpBackfillBatchesPerTimer,10));

   for(int r=0;r<rounds && !g_backfillDone;r++)
   {
      int remaining=g_backfillTarget-g_backfillCount;
      int requested=MathMin(batch,remaining);
      int startPos=1+g_backfillCount;
      MqlRates rates[];
      ArraySetAsSeries(rates,false);
      ResetLastError();
      int copied=CopyRates(g_symbol,PERIOD_M1,startPos,requested,rates);
      if(copied<=0)
      {
         int err=GetLastError();
         Log("BACKFILL WAIT | CopyRates="+IntegerToString(copied)+" error="+IntegerToString(err));
         return;
      }

      if(!SendBatch(g_symbol,rates,copied))
      {
         Log("BACKFILL PAUSED | network/worker error; will retry next timer");
         return;
      }

      if(copied<requested)
      {
         g_backfillDone=true;
         Log("BACKFILL HISTORY EXHAUSTED | copied total="+IntegerToString(g_backfillCount));
         return;
      }
      Sleep(100);
   }
}

bool GetLastClosedM1(string symbol,MqlRates &bar)
{
   MqlRates rates[];
   ArraySetAsSeries(rates,true);
   int copied=CopyRates(symbol,PERIOD_M1,1,1,rates);
   if(copied!=1) return false;
   bar=rates[0];
   return bar.time>0;
}

void ProcessFeed()
{
   if(!SymbolSelect(g_symbol,true))
   {
      Log("ERROR: Symbol not found: "+g_symbol);
      return;
   }

   MqlRates bar;
   if(!GetLastClosedM1(g_symbol,bar))
      return;

   if(bar.time!=g_lastSentBarTime)
   {
      if(SendSingleBar(g_symbol,bar,false))
         g_lastSentBarTime=bar.time;
      return;
   }

   // Re-upsert the last closed candle as a heartbeat. This updates received_at in D1
   // without inventing a synthetic price candle, so GitHub can detect MT5 even while market is closed.
   ulong elapsed=GetTickCount64()-g_lastHeartbeatTick;
   if(InpHeartbeatSeconds>0 && (g_lastHeartbeatTick==0 || elapsed>=(ulong)InpHeartbeatSeconds*1000))
      SendSingleBar(g_symbol,bar,true);
}

int OnInit()
{
   g_symbol=FeedSymbol();
   if(!IsXAUUSD(g_symbol))
   {
      Print("[OneMonth V44 Feed] ERROR: chart/input symbol is not XAUUSD: ",g_symbol);
      return INIT_FAILED;
   }
   if(StringLen(InpWebhookToken)<8)
   {
      Print("[OneMonth V44 Feed] ERROR: set InpWebhookToken in EA Inputs");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(InpTimerSeconds<1 || InpHeartbeatSeconds<5)
      return INIT_PARAMETERS_INCORRECT;

   g_backfillTarget=MathMax(300,MathMin(InpBackfillBars,120000));
   g_backfillDone=!InpBackfillOnStart;
   SymbolSelect(g_symbol,true);
   Log("START V44 | symbol="+g_symbol+" | MT5-first AUTO HYBRID | target history="+IntegerToString(g_backfillTarget)+" M1 | NO TRADING");

   if(!InpSendLastClosedOnStart)
   {
      MqlRates cur;
      if(GetLastClosedM1(g_symbol,cur)) g_lastSentBarTime=cur.time;
   }

   EventSetTimer(InpTimerSeconds);
   if(InpSendLastClosedOnStart) ProcessFeed();
   BackfillStep();
   return INIT_SUCCEEDED;
}

void OnTimer()
{
   ProcessFeed();
   BackfillStep();
}
void OnTick(){}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Log("STOP | live="+IntegerToString(g_sentCount)+" | backfill="+IntegerToString(g_backfillCount)+" | failed="+IntegerToString(g_failCount));
}
//+------------------------------------------------------------------+
