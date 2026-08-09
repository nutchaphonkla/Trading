//+------------------------------------------------------------------+
//| OneMonth_Feed_Bridge.mq5                                        |
//| MT5 XAUUSD M1 -> Cloudflare Worker/D1 fallback feed             |
//| V36.2                                                           |
//+------------------------------------------------------------------+
#property strict
#property version   "36.20"
#property description "OneMonth MT5 XAUUSD M1 fallback data bridge"

input string InpSymbol = "";
input string InpWorkerURL = "https://onemonth-tv-feed.nutchaphonsit.workers.dev/tv-webhook";
input string InpWebhookToken = "PUT_YOUR_TOKEN_HERE";
input int    InpTimerSeconds = 3;
input int    InpTimeoutMs = 8000;
input bool   InpSendLastClosedOnStart = true;
input bool   InpVerboseLog = true;

string   g_symbol = "";
datetime g_lastSentBarTime = 0;
int      g_sentCount = 0;
int      g_failCount = 0;

void Log(string text)
{
   if(InpVerboseLog)
      Print("[OneMonth Feed] ", text);
}

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", "");
   StringReplace(value, "\n", "");
   return value;
}

string GetFeedSymbol()
{
   if(StringLen(InpSymbol) > 0)
      return InpSymbol;
   return _Symbol;
}

bool IsXAUUSD(string symbol)
{
   string s = symbol;
   StringToUpper(s);
   return (StringFind(s, "XAUUSD") >= 0);
}

int GetSymbolDigits(string symbol)
{
   long digits = 2;
   if(SymbolInfoInteger(symbol, SYMBOL_DIGITS, digits))
      return (int)digits;
   return 2;
}

string BuildPayload(string symbol, MqlRates &bar)
{
   int digits = GetSymbolDigits(symbol);
   string payload = "{";
   payload += "\"source\":\"MT5\",";
   payload += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
   payload += "\"timeframe\":\"1\",";
   payload += "\"ts\":" + IntegerToString((long)bar.time) + ",";
   payload += "\"open\":" + DoubleToString(bar.open, digits) + ",";
   payload += "\"high\":" + DoubleToString(bar.high, digits) + ",";
   payload += "\"low\":" + DoubleToString(bar.low, digits) + ",";
   payload += "\"close\":" + DoubleToString(bar.close, digits);
   payload += "}";
   return payload;
}

bool StringToUtf8(string text, char &data[])
{
   ArrayResize(data, 0);
   int copied = StringToCharArray(text, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(copied <= 0)
      return false;
   if(ArraySize(data) > 0)
      ArrayResize(data, ArraySize(data) - 1);
   return true;
}

bool SendBar(string symbol, MqlRates &bar)
{
   if(StringLen(InpWebhookToken) < 8)
   {
      Log("ERROR: WEBHOOK_TOKEN ยังไม่ได้ตั้ง");
      return false;
   }

   string payload = BuildPayload(symbol, bar);
   char requestData[];
   char responseData[];
   if(!StringToUtf8(payload, requestData))
      return false;

   string headers = "Content-Type: application/json\r\n";
   headers += "Authorization: Bearer " + InpWebhookToken + "\r\n";
   headers += "User-Agent: OneMonth-MT5-Bridge/36.2\r\n";
   string responseHeaders = "";

   ResetLastError();
   int httpCode = WebRequest(
      "POST",
      InpWorkerURL,
      headers,
      InpTimeoutMs,
      requestData,
      responseData,
      responseHeaders
   );

   if(httpCode == -1)
   {
      int err = GetLastError();
      g_failCount++;
      Log("WEBREQUEST FAILED | error=" + IntegerToString(err));
      return false;
   }

   string response = CharArrayToString(responseData, 0, -1, CP_UTF8);
   if(httpCode >= 200 && httpCode < 300)
   {
      g_sentCount++;
      Log("SENT OK | " + symbol + " | " + TimeToString(bar.time, TIME_DATE|TIME_MINUTES) + " | HTTP " + IntegerToString(httpCode));
      return true;
   }

   g_failCount++;
   Log("WORKER ERROR | HTTP " + IntegerToString(httpCode) + " | " + response);
   return false;
}

bool GetLastClosedM1(string symbol, MqlRates &bar)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(symbol, PERIOD_M1, 1, 1, rates);
   if(copied != 1)
      return false;
   bar = rates[0];
   return (bar.time > 0);
}

void ProcessFeed()
{
   if(!SymbolSelect(g_symbol, true))
      return;

   MqlRates bar;
   if(!GetLastClosedM1(g_symbol, bar))
      return;

   if(bar.time == g_lastSentBarTime)
      return;

   if(SendBar(g_symbol, bar))
      g_lastSentBarTime = bar.time;
}

int OnInit()
{
   g_symbol = GetFeedSymbol();
   if(!IsXAUUSD(g_symbol))
      return INIT_FAILED;
   if(StringLen(InpWebhookToken) < 8 || InpTimerSeconds < 1)
      return INIT_PARAMETERS_INCORRECT;

   SymbolSelect(g_symbol, true);
   EventSetTimer(InpTimerSeconds);
   Log("STARTED V36.2 | Symbol=" + g_symbol);

   if(!InpSendLastClosedOnStart)
   {
      MqlRates current;
      if(GetLastClosedM1(g_symbol, current))
         g_lastSentBarTime = current.time;
   }
   else
   {
      ProcessFeed();
   }

   return INIT_SUCCEEDED;
}

void OnTimer() { ProcessFeed(); }
void OnTick()  {}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Log("STOPPED | sent=" + IntegerToString(g_sentCount) + " | failed=" + IntegerToString(g_failCount));
}
//+------------------------------------------------------------------+
