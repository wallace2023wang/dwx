package workbench.res;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Properties;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import org.kie.api.builder.Message;
import org.kie.api.builder.Results;
import org.kie.api.definition.type.FactField;
import org.kie.api.definition.type.FactType;
import org.kie.api.event.rule.AfterMatchFiredEvent;
import org.kie.api.event.rule.DefaultAgendaEventListener;
import org.kie.api.io.ResourceType;
import org.kie.api.runtime.KieContainer;
import org.kie.api.runtime.KieContainerSessionsPool;
import org.kie.api.runtime.KieSession;
import org.kie.internal.utils.KieHelper;

public final class ResServer {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String DROOLS_VERSION = "10.2.0";
  private static final int MAX_BODY = 2 * 1024 * 1024;
  private static final int MAX_FIRES_PER_STEP = 100;
  private static final Path DATA_DIR = Path.of(System.getenv().getOrDefault("RES_DATA_DIR", "data/releases"));
  private static final Path CONFIG_FILE = Path.of(System.getenv().getOrDefault("RES_CONFIG_FILE", "config/res.properties"));
  private static final int SESSION_POOL_SIZE = loadSessionPoolSize();
  private static final Map<String, Deployment> DEPLOYMENTS = new ConcurrentHashMap<>();
  private static final Object DEPLOY_LOCK = new Object();

  // factTypes: 从编译后 DRL 的 declare RuleInput 反射得到的字段名→Java 类型映射。
  // RES 不保存 BOM 副本，DRL 里的 declare 块就是字段表的冻结快照。
  private record Deployment(JsonNode release, List<KieContainerSessionsPool> sessionPools, Map<String, Class<?>> factTypes, String deployedAt) {
    void shutdown() {
      for (KieContainerSessionsPool pool : sessionPools) pool.shutdown();
    }
  }
  private static final class CompileFailure extends Exception {
    private final List<String> errors;
    CompileFailure(List<String> errors) { super(String.join("\n", errors)); this.errors = errors; }
  }

  public static void main(String[] args) throws IOException {
    Files.createDirectories(DATA_DIR);
    loadDeployments();
    Runtime.getRuntime().addShutdownHook(new Thread(ResServer::shutdownDeployments));
    int port = Integer.parseInt(System.getenv().getOrDefault("RES_PORT", "8790"));
    HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
    server.createContext("/health", ResServer::health);
    server.createContext("/deployments", ResServer::listDeployments);
    server.createContext("/deploy", ResServer::deploy);
    server.createContext("/execute", ResServer::execute);
    server.setExecutor(Executors.newFixedThreadPool(Math.max(4, Runtime.getRuntime().availableProcessors())));
    server.start();
    System.out.println("Rule Execution Server listening on " + port + ", loaded " + DEPLOYMENTS.size() + " release(s)");
  }


  private static int loadSessionPoolSize() {
    Properties properties = new Properties();
    if (Files.isRegularFile(CONFIG_FILE)) {
      try (var input = Files.newInputStream(CONFIG_FILE)) {
        properties.load(input);
      } catch (IOException exception) {
        System.err.println("无法读取 RES 配置文件 " + CONFIG_FILE + "，使用默认 session pool size=2：" + exception.getMessage());
      }
    }
    String raw = properties.getProperty("kie.session.pool.size", "2").trim();
    try {
      int value = Integer.parseInt(raw);
      return value > 0 ? value : 2;
    } catch (NumberFormatException exception) {
      System.err.println("RES 配置 kie.session.pool.size 无效，使用默认值 2：" + raw);
      return 2;
    }
  }

  private static void shutdownDeployments() {
    for (Deployment deployment : DEPLOYMENTS.values()) deployment.shutdown();
  }

  private static void health(HttpExchange exchange) throws IOException {
    if (!method(exchange, "GET")) return;
    send(exchange, 200, Map.of(
        "service", "Rule Execution Server",
        "engine", "Drools",
        "version", DROOLS_VERSION,
        "sessionPoolSize", SESSION_POOL_SIZE,
        "deployments", DEPLOYMENTS.size()));
  }

  private static void listDeployments(HttpExchange exchange) throws IOException {
    if (!method(exchange, "GET")) return;
    List<Map<String, Object>> result = DEPLOYMENTS.values().stream()
        .map(deployment -> deploymentSummary(deployment.release(), deployment.deployedAt()))
        .sorted((left, right) -> String.valueOf(right.get("deployedAt")).compareTo(String.valueOf(left.get("deployedAt"))))
        .toList();
    send(exchange, 200, result);
  }

  private static void deploy(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    JsonNode release;
    try { release = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    String validation = validateRelease(release);
    if (validation != null) { send(exchange, 400, Map.of("error", validation)); return; }
    String id = release.path("id").asText();

    synchronized (DEPLOY_LOCK) {
      Deployment existing = DEPLOYMENTS.get(id);
      if (existing != null) {
        if (!existing.release().path("checksum").asText().equals(release.path("checksum").asText())) {
          send(exchange, 409, Map.of("error", "相同 Release ID 已存在不同内容")); return;
        }
        send(exchange, 200, deploymentResponse(existing.release(), existing.deployedAt())); return;
      }

      Deployment deployment;
      try { deployment = buildDeployment(release, Instant.now().toString()); }
      catch (CompileFailure failure) { send(exchange, 422, Map.of("ok", false, "errors", failure.errors)); return; }
      try {
        persist(deployment);
      } catch (IOException exception) {
        deployment.shutdown();
        throw exception;
      }
      DEPLOYMENTS.put(id, deployment);
      send(exchange, 201, deploymentResponse(release, deployment.deployedAt()));
    }
  }

  private static void execute(HttpExchange exchange) throws IOException {
    if (!method(exchange, "POST")) return;
    long started = System.nanoTime();
    JsonNode request;
    try { request = readBody(exchange); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }
    String releaseId = request.path("releaseId").asText("");
    Deployment deployment = DEPLOYMENTS.get(releaseId);
    if (deployment == null) { send(exchange, 404, Map.of("error", "Release 未部署")); return; }
    JsonNode input = request.path("facts");
    if (!input.isObject()) { send(exchange, 400, Map.of("error", "facts 必须是对象")); return; }
    String requiredError = requiredFactError(deployment.release(), input);
    if (requiredError != null) { send(exchange, 400, Map.of("error", requiredError)); return; }
    Map<String, Object> facts;
    try { facts = parseFacts(input, deployment.factTypes()); }
    catch (IllegalArgumentException exception) { send(exchange, 400, Map.of("error", exception.getMessage())); return; }

    ArrayList<Map<String, Object>> trace = new ArrayList<>();
    int total = 0;
    boolean limitReached = false;
    JsonNode steps = deployment.release().path("steps");
    JsonNode routing = deployment.release().path("routing");
    int branchStart = routing.isObject() ? routing.path("afterStep").asInt() : steps.size();
    Set<Integer> selectedStepIndexes = null;
    JsonNode selectedBranch = null;
    Map<Integer, String> routedNodeIds = new HashMap<>();
    if (routing.isObject()) {
      for (JsonNode branch : routing.path("branches")) {
        int ordinal = 0;
        for (JsonNode value : branch.path("stepIndexes")) {
          routedNodeIds.put(value.asInt(), "branch:" + branch.path("id").asText() + ":" + ordinal++);
        }
      }
    }
    JsonNode currentStep = null;
    String currentNodeId = null;
    try {
      for (int index = 0; index < deployment.sessionPools().size(); index++) {
        if (routing.isObject() && index == branchStart) {
          selectedBranch = selectBranch(routing.path("branches"), facts);
          selectedStepIndexes = new HashSet<>();
          if (selectedBranch != null) for (JsonNode value : selectedBranch.path("stepIndexes")) selectedStepIndexes.add(value.asInt());
          Map<String, Object> gateway = new LinkedHashMap<>();
          gateway.put("name", "条件网关");
          gateway.put("type", "gateway");
          gateway.put("nodeId", "gateway");
          gateway.put("branchId", selectedBranch == null ? null : selectedBranch.path("id").asText());
          gateway.put("branchName", selectedBranch == null ? null : selectedBranch.path("name").asText());
          gateway.put("default", selectedBranch != null && selectedBranch.path("default").asBoolean(false));
          gateway.put("count", 0);
          gateway.put("facts", new LinkedHashMap<>(facts));
          trace.add(gateway);
        }
        if (index >= branchStart && (selectedStepIndexes == null || !selectedStepIndexes.contains(index))) continue;
        JsonNode step = steps.get(index);
        currentStep = step;
        currentNodeId = index < branchStart ? "common:" + index : routedNodeIds.get(index);
        List<Map<String, Object>> inputMappings = applyMappings(step.path("inputMappings"), facts);
        KieSession session = deployment.sessionPools().get(index).newKieSession();
        try {
          FactType type = session.getKieBase().getFactType("workbench", "RuleInput");
          if (type == null) throw new IllegalStateException("Release 缺少 workbench.RuleInput 类型");
          Object fact = type.newInstance();
          for (Map.Entry<String, Object> entry : facts.entrySet()) type.set(fact, entry.getKey(), entry.getValue());
          List<String> fired = new ArrayList<>();
          session.addEventListener(new DefaultAgendaEventListener() {
            @Override public void afterMatchFired(AfterMatchFiredEvent event) {
              fired.add(event.getMatch().getRule().getName());
            }
          });
          session.insert(fact);
          int count = session.fireAllRules(MAX_FIRES_PER_STEP);
          List<Map<String, Object>> decisionHits = collectDecisionHits(session);
          total += count;
          limitReached = count == MAX_FIRES_PER_STEP;
          for (String key : deployment.factTypes().keySet()) {
            Object value = type.get(fact, key);
            if (value != null) facts.put(key, value);
          }
          List<Map<String, Object>> outputMappings = applyMappings(step.path("outputMappings"), facts);
          Map<String, Object> item = new LinkedHashMap<>();
          item.put("name", step.path("name").asText());
          item.put("type", step.path("type").asText());
          item.put("nodeId", currentNodeId);
          item.put("assetVersion", step.path("assetVersion").asInt());
          item.put("fired", fired);
          item.put("decisionHits", decisionHits);
          item.put("count", count);
          item.put("facts", new LinkedHashMap<>(facts));
          Map<String, Object> mappings = new LinkedHashMap<>();
          mappings.put("inputs", inputMappings);
          mappings.put("outputs", outputMappings);
          item.put("mappings", mappings);
          trace.add(item);
          if (limitReached) break;
        } finally { session.dispose(); }
      }
    } catch (Exception exception) {
      exception.printStackTrace();
      Map<String, Object> failure = new LinkedHashMap<>();
      failure.put("error", "规则执行失败");
      Map<String, Object> failedStep = new LinkedHashMap<>();
      failedStep.put("nodeId", currentNodeId);
      failedStep.put("name", currentStep == null ? null : currentStep.path("name").asText());
      failedStep.put("type", currentStep == null ? null : currentStep.path("type").asText());
      failedStep.put("assetVersion", currentStep == null ? null : currentStep.path("assetVersion").asInt());
      failure.put("failedStep", failedStep);
      failure.put("facts", facts);
      failure.put("trace", trace);
      send(exchange, 500, failure); return;
    }

    String requestId = request.path("requestId").isTextual() && request.path("requestId").asText().length() <= 100
        ? request.path("requestId").asText() : UUID.randomUUID().toString();
    Map<String, Object> response = new LinkedHashMap<>();
    response.put("ok", true);
    response.put("requestId", requestId);
    response.put("releaseId", releaseId);
    response.put("decisionService", deployment.release().path("decisionService").asText());
    response.put("version", deployment.release().path("version").asInt());
    response.put("facts", facts);
    response.put("trace", trace);
    if (routing.isObject()) {
      Map<String, Object> path = new LinkedHashMap<>();
      path.put("branchId", selectedBranch == null ? null : selectedBranch.path("id").asText());
      path.put("branchName", selectedBranch == null ? null : selectedBranch.path("name").asText());
      path.put("default", selectedBranch != null && selectedBranch.path("default").asBoolean(false));
      response.put("path", path);
    }
    response.put("count", total);
    response.put("limitReached", limitReached);
    response.put("durationMs", (System.nanoTime() - started) / 1_000_000.0);
    send(exchange, 200, response);
  }

  private static JsonNode selectBranch(JsonNode branches, Map<String, Object> facts) {
    JsonNode fallback = null;
    for (JsonNode branch : branches) {
      if (branch.path("default").asBoolean(false)) {
        fallback = branch;
      } else if (conditionMatches(branch.path("condition"), facts)) {
        return branch;
      }
    }
    return fallback;
  }

  private static List<Map<String, Object>> applyMappings(JsonNode mappings, Map<String, Object> facts) {
    List<Map<String, Object>> trace = new ArrayList<>();
    if (!mappings.isArray()) return trace;
    for (JsonNode mapping : mappings) {
      String source = mapping.path("source").asText();
      String target = mapping.path("target").asText();
      boolean applied = facts.containsKey(source) && facts.get(source) != null;
      Object value = applied ? facts.get(source) : null;
      if (applied) facts.put(target, value);
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("source", source);
      item.put("target", target);
      item.put("value", value);
      item.put("applied", applied);
      trace.add(item);
    }
    return trace;
  }

  private static boolean conditionMatches(JsonNode condition, Map<String, Object> facts) {
    Object actual = facts.get(condition.path("field").asText());
    if (actual == null) return false;
    JsonNode expected = condition.path("value");
    String operator = condition.path("operator").asText();
    int comparison;
    if (actual instanceof Number number && expected.isNumber()) {
      comparison = Double.compare(number.doubleValue(), expected.doubleValue());
    } else if (actual instanceof String text && expected.isTextual()) {
      comparison = text.compareTo(expected.asText());
    } else if (actual instanceof Boolean value && expected.isBoolean()) {
      comparison = Boolean.compare(value, expected.asBoolean());
    } else {
      return false;
    }
    return switch (operator) {
      case "==" -> comparison == 0;
      case "!=" -> comparison != 0;
      case ">" -> comparison > 0;
      case ">=" -> comparison >= 0;
      case "<" -> comparison < 0;
      case "<=" -> comparison <= 0;
      default -> false;
    };
  }

  private static Deployment buildDeployment(JsonNode release, String deployedAt) throws CompileFailure {
    List<KieContainer> containers = compile(release);
    Map<String, Class<?>> factTypes = reflectFactTypes(containers.get(0));
    List<KieContainerSessionsPool> pools = containers.stream()
        .map(container -> container.newKieSessionsPool(SESSION_POOL_SIZE))
        .toList();
    return new Deployment(release.deepCopy(), pools, factTypes, deployedAt);
  }

  private static List<KieContainer> compile(JsonNode release) throws CompileFailure {
    List<KieContainer> containers = new ArrayList<>();
    List<String> errors = new ArrayList<>();
    for (int index = 0; index < release.path("steps").size(); index++) {
      JsonNode step = release.path("steps").get(index);
      KieHelper helper = new KieHelper().addContent(step.path("drl").asText(), ResourceType.DRL);
      Results results = helper.verify();
      List<String> stepErrors = results.getMessages(Message.Level.ERROR).stream().map(Message::getText).toList();
      if (!stepErrors.isEmpty()) {
        for (String error : stepErrors) errors.add(step.path("name").asText() + "：" + error);
      } else containers.add(helper.getKieContainer());
    }
    if (!errors.isEmpty()) throw new CompileFailure(errors);
    return containers;
  }

  private static String validateRelease(JsonNode release) {
    if (release == null || !release.isObject()) return "发布包必须是对象";
    if (release.path("schemaVersion").asInt(-1) != 1) return "不支持的发布包格式";
    String id = release.path("id").asText("");
    if (!id.matches("[A-Za-z0-9._-]{1,100}")) return "Release ID 无效";
    if (!release.path("decisionService").asText("").matches("[a-z0-9][a-z0-9._/-]{2,79}")) return "决策服务标识无效";
    if (!"drools".equals(release.path("engine").path("type").asText())
        || !DROOLS_VERSION.equals(release.path("engine").path("drools").asText())) return "Drools 版本不兼容";
    if (release.has("model")) {
      JsonNode model = release.path("model");
      if (!model.isObject() || !model.path("version").canConvertToInt() || model.path("version").asInt() < 1
          || !model.path("fields").isArray() || model.path("fields").isEmpty()) return "发布包字段模型无效";
    }
    JsonNode steps = release.path("steps");
    if (!steps.isArray() || steps.isEmpty() || steps.size() > 20) return "发布包步骤数量无效";
    int totalDrl = 0;
    for (JsonNode step : steps) {
      if (!step.path("name").isTextual() || step.path("name").asText().isBlank()) return "发布包步骤名称无效";
      // rule-group 是规则流里的"整包执行"步骤：快照已把成员规则合成为完整 DRL，
      // 执行方式与 rule/table 完全相同，因此这里只需放行类型。
      if (!List.of("rule", "table", "rule-group").contains(step.path("type").asText())) return "发布包步骤类型无效";
      if (!step.path("drl").isTextual() || step.path("drl").asText().length() > 200_000) return "发布包 DRL 无效或过大";
      if (!validStepMappings(step, release.path("model"))) return "发布包步骤字段映射无效";
      totalDrl += step.path("drl").asText().length();
    }
    if (totalDrl > 1_000_000) return "发布包总大小超限";
    if (release.has("routing")) {
      JsonNode routing = release.path("routing");
      int afterStep = routing.path("afterStep").asInt(-1);
      JsonNode branches = routing.path("branches");
      if (!"exclusive".equals(routing.path("type").asText()) || afterStep < 0 || afterStep > steps.size()
          || !branches.isArray() || branches.isEmpty() || branches.size() > 8 || !release.path("model").isObject()) return "发布包路由定义无效";
      Set<String> ids = new HashSet<>();
      Set<Integer> indexes = new HashSet<>();
      int defaults = 0;
      int conditions = 0;
      for (JsonNode branch : branches) {
        String branchId = branch.path("id").asText("");
        if (branchId.isBlank() || !ids.add(branchId) || branch.path("name").asText("").isBlank()
            || !branch.path("stepIndexes").isArray() || branch.path("stepIndexes").isEmpty()) return "发布包路由分支无效";
        for (JsonNode value : branch.path("stepIndexes")) {
          if (!value.isIntegralNumber()) return "发布包路由步骤索引无效";
          int stepIndex = value.asInt(-1);
          if (stepIndex < afterStep || stepIndex >= steps.size() || !indexes.add(stepIndex)) return "发布包路由步骤索引无效";
        }
        if (branch.path("default").asBoolean(false)) defaults++;
        else {
          conditions++;
          JsonNode condition = branch.path("condition");
          if (!condition.isObject() || condition.path("field").asText("").isBlank()
              || !List.of("==", "!=", ">", ">=", "<", "<=").contains(condition.path("operator").asText())
              || condition.path("value").isMissingNode() || condition.path("value").isNull()) return "发布包路由条件无效";
        }
      }
      if (conditions == 0 || defaults > 1 || indexes.size() != steps.size() - afterStep) return "发布包路由定义不完整";
    }
    String expected;
    try { expected = checksum(release); }
    catch (Exception exception) { return "无法计算发布包校验和"; }
    if (!expected.equals(release.path("checksum").asText())) return "发布包校验和不匹配";
    return null;
  }

  private static boolean validStepMappings(JsonNode step, JsonNode model) {
    for (String key : List.of("inputMappings", "outputMappings")) {
      JsonNode mappings = step.path(key);
      if (mappings.isMissingNode()) continue;
      if (!model.isObject() || !mappings.isArray() || mappings.isEmpty() || mappings.size() > 20) return false;
      Set<String> targets = new HashSet<>();
      for (JsonNode mapping : mappings) {
        JsonNode source = modelField(model, mapping.path("source").asText(""));
        JsonNode target = modelField(model, mapping.path("target").asText(""));
        if (source == null || target == null || !source.path("type").asText().equals(target.path("type").asText())
            || source.path("key").asText().equals(target.path("key").asText())
            || !targets.add(target.path("key").asText())) return false;
        if ("inputMappings".equals(key) && !"input".equals(target.path("kind").asText())) return false;
        if ("outputMappings".equals(key) && !"output".equals(source.path("kind").asText())) return false;
      }
    }
    return true;
  }

  private static JsonNode modelField(JsonNode model, String key) {
    if (!model.path("fields").isArray()) return null;
    for (JsonNode field : model.path("fields")) {
      if (key.equals(field.path("key").asText())) return field;
    }
    return null;
  }

  private static String checksum(JsonNode release) throws Exception {
    ObjectNode content = JSON.createObjectNode();
    for (String key : List.of("schemaVersion", "decisionService", "version", "name", "description", "target", "engine", "steps")) {
      content.set(key, release.get(key));
    }
    if (release.has("model")) content.set("model", release.get("model"));
    if (release.has("routing")) content.set("routing", release.get("routing"));
    byte[] bytes = JSON.writeValueAsBytes(canonical(content));
    return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  private static Object canonical(JsonNode node) {
    if (node == null || node.isNull()) return null;
    if (node.isObject()) {
      TreeMap<String, Object> values = new TreeMap<>();
      Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
      while (fields.hasNext()) {
        Map.Entry<String, JsonNode> field = fields.next();
        values.put(field.getKey(), canonical(field.getValue()));
      }
      return values;
    }
    if (node.isArray()) {
      List<Object> values = new ArrayList<>();
      for (JsonNode value : node) values.add(canonical(value));
      return values;
    }
    if (node.isIntegralNumber()) return node.longValue();
    if (node.isFloatingPointNumber()) return node.doubleValue();
    if (node.isBoolean()) return node.booleanValue();
    return node.asText();
  }

  private static List<Map<String, Object>> collectDecisionHits(KieSession session) {
    FactType type = session.getKieBase().getFactType("workbench", "DecisionHit");
    List<Map<String, Object>> hits = new ArrayList<>();
    if (type == null) return hits;
    for (Object object : session.getObjects()) {
      if (!type.getFactClass().isInstance(object)) continue;
      Map<String, Object> hit = new LinkedHashMap<>();
      for (FactField field : type.getFields()) hit.put(field.getName(), type.get(object, field.getName()));
      hits.add(hit);
    }
    return hits;
  }

  /**
   * 从 KieContainer 中反射 workbench.RuleInput 的字段名与类型。
   * DRL 的 declare 块就是 BOM 的冻结快照，RES 无需回查 Team Server。
   */
  private static Map<String, Class<?>> reflectFactTypes(KieContainer container) {
    FactType type = container.getKieBase().getFactType("workbench", "RuleInput");
    if (type == null) throw new IllegalStateException("Release 缺少 workbench.RuleInput 类型");
    Map<String, Class<?>> map = new LinkedHashMap<>();
    for (FactField field : type.getFields()) {
      map.put(field.getName(), field.getType());
    }
    return map;
  }

  /**
   * 按 FactType 声明的类型 coerce 调用方传入的 facts。
   * 未知 key 拒绝；类型不匹配拒绝。
   */
  private static Map<String, Object> parseFacts(JsonNode input, Map<String, Class<?>> factTypes) {
    Map<String, Object> facts = new LinkedHashMap<>();
    Iterator<String> keys = input.fieldNames();
    while (keys.hasNext()) {
      String key = keys.next();
      Class<?> type = factTypes.get(key);
      if (type == null) throw new IllegalArgumentException("未知事实字段：" + key);
      JsonNode value = input.get(key);
      if (value == null || value.isNull()) continue;
      Object typed = coerce(value, type);
      if (typed == null) throw new IllegalArgumentException("事实字段类型无效：" + key);
      facts.put(key, typed);
    }
    return facts;
  }

  private static String requiredFactError(JsonNode release, JsonNode input) {
    JsonNode fields = release.path("model").path("fields");
    if (!fields.isArray()) return null;
    List<String> missing = new ArrayList<>();
    for (JsonNode field : fields) {
      if (!"input".equals(field.path("kind").asText()) || !field.path("required").asBoolean(false)) continue;
      String key = field.path("key").asText();
      if (!input.has(key) || input.path(key).isNull() || (input.path(key).isTextual() && input.path(key).asText().isEmpty())) missing.add(key);
    }
    return missing.isEmpty() ? null : "缺少必填事实字段：" + String.join("、", missing);
  }

  private static Object coerce(JsonNode value, Class<?> type) {
    if (type == Integer.class || type == int.class) {
      return value.isIntegralNumber() && value.canConvertToInt() ? value.intValue() : null;
    }
    if (type == Double.class || type == double.class) {
      return value.isNumber() && Double.isFinite(value.doubleValue()) ? value.doubleValue() : null;
    }
    if (type == Boolean.class || type == boolean.class) {
      return value.isBoolean() ? value.booleanValue() : null;
    }
    if (type == String.class) {
      return value.isTextual() && value.asText().length() <= 200 ? value.asText() : null;
    }
    return null;
  }

  private static void persist(Deployment deployment) throws IOException {
    String id = deployment.release().path("id").asText();
    ObjectNode wrapper = JSON.createObjectNode();
    wrapper.set("release", deployment.release());
    wrapper.put("deployedAt", deployment.deployedAt());
    Path target = DATA_DIR.resolve(id + ".json");
    Path temporary = DATA_DIR.resolve(id + "." + ProcessHandle.current().pid() + ".tmp");
    JSON.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), wrapper);
    try { Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
    catch (AtomicMoveNotSupportedException exception) { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING); }
  }

  private static void loadDeployments() throws IOException {
    try (DirectoryStream<Path> files = Files.newDirectoryStream(DATA_DIR, "*.json")) {
      for (Path file : files) {
        try {
          JsonNode wrapper = JSON.readTree(file.toFile());
          JsonNode release = wrapper.path("release");
          String error = validateRelease(release);
          if (error != null) throw new IllegalArgumentException(error);
          DEPLOYMENTS.put(release.path("id").asText(), buildDeployment(
              release, wrapper.path("deployedAt").asText(Instant.EPOCH.toString())));
        } catch (Exception exception) {
          System.err.println("忽略无法加载的 Release " + file.getFileName() + "：" + exception.getMessage());
        }
      }
    }
  }

  private static Map<String, Object> deploymentSummary(JsonNode release, String deployedAt) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("deploymentId", "local:" + release.path("id").asText());
    result.put("releaseId", release.path("id").asText());
    result.put("decisionService", release.path("decisionService").asText());
    result.put("version", release.path("version").asInt());
    result.put("name", release.path("name").asText());
    result.put("checksum", release.path("checksum").asText());
    if (release.has("model")) result.put("modelVersion", release.path("model").path("version").asInt());
    result.put("steps", release.path("steps").size());
    result.put("sessionPoolSize", SESSION_POOL_SIZE);
    result.put("deployedAt", deployedAt);
    return result;
  }

  private static Map<String, Object> deploymentResponse(JsonNode release, String deployedAt) {
    return deploymentSummary(release, deployedAt);
  }

  private static JsonNode readBody(HttpExchange exchange) throws IOException {
    byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
    if (body.length > MAX_BODY) throw new IllegalArgumentException("请求内容过大");
    try {
      JsonNode parsed = JSON.readTree(body);
      if (parsed == null) throw new IllegalArgumentException("请求体不能为空");
      return parsed;
    } catch (IOException exception) { throw new IllegalArgumentException("JSON 格式无效"); }
  }

  private static boolean method(HttpExchange exchange, String expected) throws IOException {
    if (expected.equals(exchange.getRequestMethod())) return true;
    send(exchange, 405, Map.of("error", "Method not allowed"));
    return false;
  }

  private static void send(HttpExchange exchange, int status, Object body) throws IOException {
    byte[] bytes = JSON.writeValueAsBytes(body);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.getResponseHeaders().set("Cache-Control", "no-store");
    exchange.sendResponseHeaders(status, bytes.length);
    try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
  }
}
